// ═══ Mapbox Style Spec subset the converter understands ═══

export interface MapboxStyle {
  version?: number
  name?: string
  sources?: Record<string, MapboxSource>
  layers?: MapboxLayer[]
  /** Initial map state — same five fields Mapbox / MapLibre expose at
   *  the style root. The compiler doesn't encode these into xgis source
   *  (no top-level camera directive in xgis); the importer reads them
   *  directly off the raw JSON and applies via Camera assignment +
   *  `markCameraPositioned()`. URL-hash camera still wins because the
   *  importer applies AFTER hash parsing, so a deep-link survives. */
  center?: [number, number]
  zoom?: number
  bearing?: number
  pitch?: number
  /** SDF glyph PBF URL template (`{fontstack}` + `{range}` placeholders).
   *  The compiler doesn't encode this into xgis source — it's a pure
   *  runtime concern, so the style importer extracts it from the raw
   *  JSON and forwards it to `XGISMap.setGlyphsUrl()`. Declared here
   *  for type safety on importers that read the field directly. */
  glyphs?: string
  /** Sprite atlas URL prefix. The runtime fetches `${sprite}.json`
   *  and `${sprite}.png` (or `@2x` variants on hidpi) to load icon
   *  metadata + raster. Same plumbing pattern as `glyphs` — the
   *  importer forwards this to `XGISMap.setSpriteUrl()`; the
   *  compiler does NOT encode it into xgis source. */
  sprite?: string
  // Other top-level fields (metadata) still ignored.
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
