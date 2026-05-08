// ═══ Mapbox Style Spec subset the converter understands ═══

export interface MapboxStyle {
  version?: number
  name?: string
  sources?: Record<string, MapboxSource>
  layers?: MapboxLayer[]
  // Other top-level fields (sprite, glyphs, metadata) ignored for now.
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
