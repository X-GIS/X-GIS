// ═══ Mapbox style-spec `projection` → X-GIS projection name ═══
//
// WS-8. The Mapbox/MapLibre top-level `projection` field is host-applied
// in X-GIS — the xgis DSL carries no projection state (same pattern as
// center/zoom/bearing/pitch). The demo-runner + compare-runner read the
// raw style JSON and call XGISMap.setProjection() with the name returned
// here. setProjection() aliases the Mapbox camelCase names
// (naturalEarth → natural_earth) and validates: unknown / unsupported
// types (albers, equalEarth, lambertConformalConic, winkelTripel) warn
// and keep the current projection. So this extractor only needs to
// surface a usable static type name — name-mapping + validation live in
// the runtime.

/** Pull the projection type name out of a Mapbox style's top-level
 *  `projection` field. Handles the spec's forms:
 *    - string:           `"globe"`
 *    - object:           `{ "type": "globe" }`
 *    - transition expr:  `{ "type": ["interpolate", …, "globe", …] }` → null
 *  Returns the raw (un-aliased) Mapbox type name — setProjection maps it —
 *  or null when the field is absent / not a single static name. */
export function extractMapboxProjectionName(style: unknown): string | null {
  if (style === null || typeof style !== 'object') return null
  const proj = (style as { projection?: unknown }).projection
  if (proj === null || proj === undefined) return null
  if (typeof proj === 'string') return proj.length > 0 ? proj : null
  if (typeof proj === 'object' && !Array.isArray(proj)) {
    const t = (proj as { type?: unknown }).type
    // The zoom-interpolated transition form ({ type: ["interpolate", …] })
    // has no single static projection — leave it to the runtime default
    // (mercator) rather than guess a keyframe.
    if (typeof t === 'string' && t.length > 0) return t
  }
  return null
}
