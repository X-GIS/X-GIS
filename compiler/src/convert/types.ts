// ═══ Mapbox Style Spec subset the converter understands ═══

export interface MapboxStyle {
  version?: number
  name?: string
  sources?: Record<string, MapboxSource>
  layers?: MapboxLayer[]
  /** SDF glyph PBF URL template (`{fontstack}` + `{range}` placeholders).
   *  The compiler doesn't encode this into xgis source — it's a pure
   *  runtime concern, so the style importer extracts it from the raw
   *  JSON and forwards it to `XGISMap.setGlyphsUrl()`. Declared here
   *  for type safety on importers that read the field directly. */
  glyphs?: string
  // Other top-level fields (sprite, metadata) still ignored.
}

export interface MapboxSource {
  type: string
  url?: string
  tiles?: string[]
  minzoom?: number
  maxzoom?: number
  scheme?: string
  bounds?: number[]
}

export interface MapboxLayer {
  id: string
  type: string
  source?: string
  'source-layer'?: string
  minzoom?: number
  maxzoom?: number
  paint?: Record<string, unknown>
  layout?: Record<string, unknown>
  filter?: unknown
}
