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
   *  compiler does NOT encode it into xgis source.
   *
   *  MapLibre also permits the multi-sprite array form —
   *  `[{ id: "default", url: "…" }, { id: "extra", url: "…" }]` —
   *  for styles that address more than one atlas via an
   *  `otherId:icon-name` prefixed `icon-image` value (#2007). X-GIS
   *  renders a single atlas, so the converter collects only one entry
   *  (see mapbox-to-xgis.ts) and warns about the rest. */
  sprite?: string | { id?: string; url?: string }[]
  /** Known-but-unsupported top-level fields — declared only so the
   *  converter can detect them and warn; never encoded into xgis source. */
  fog?: unknown
  lights?: unknown
  terrain?: unknown
  transition?: unknown
  imports?: unknown
  models?: unknown
  /** MapLibre `sky` root — the zenith-angle sky gradient. Host-applied
   *  like `light` (T5 Phase 1, #2052): the demo-runner + compare-runner
   *  read the block and call `XGISMap.setAtmosphere({ sky })`, so it is
   *  NOT in the ignored-top-level list. The converter still reads it to
   *  warn about the sub-properties this phase does not carry. */
  sky?: unknown
  /** MapLibre object-form camera projection (`{ type: "globe" }` etc).
   *  Genuinely host/runtime territory in X-GIS (XGISMap.setProjection) —
   *  unlike fog/lights/terrain above this isn't an unimplemented
   *  feature, but the COMPILER itself never reads or maps it (#2007);
   *  declared here only so the ignored-top-level warning can name it. */
  projection?: unknown
  /** MapLibre global-state defaults (paired with the `["global-state"]`
   *  expression). Not read by the converter (#2007) — declared only so
   *  the ignored-top-level warning can name it. */
  state?: unknown
  /** MapLibre local font-face declarations. Not read by the converter
   *  (#2007) — declared only so the ignored-top-level warning can name
   *  it. */
  'font-faces'?: unknown
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
