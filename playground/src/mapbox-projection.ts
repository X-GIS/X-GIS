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

// ═══ Mapbox style-spec `light` → XGISMap.setLight() (WS-9) ═══
//
// `light` is host-applied like projection/camera (not encoded in the xgis
// DSL): the demo-runner + compare-runner read the block and call
// XGISMap.setLight(). anchor is read by the spec but the runtime keeps its
// camera-anchor directional frame, so it is not surfaced here.

export interface MapboxLightOptions {
  position?: [number, number, number]
  intensity?: number
  color?: [number, number, number]
}

/** Parse a CSS colour (hex / rgb()/rgba() / white|black) to RGB 0..1.
 *  Light colour only needs an approximate tint, so this covers the common
 *  authored forms; returns null when unparseable. */
function parseCssRGB(s: string): [number, number, number] | null {
  const str = s.trim().toLowerCase()
  if (str === 'white') return [1, 1, 1]
  if (str === 'black') return [0, 0, 0]
  const hex = str.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/)
  if (hex) {
    const h = hex[1]!
    if (h.length === 3) {
      return [parseInt(h[0]! + h[0]!, 16) / 255, parseInt(h[1]! + h[1]!, 16) / 255, parseInt(h[2]! + h[2]!, 16) / 255]
    }
    return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255]
  }
  const m = str.match(/^rgba?\(([^)]+)\)$/)
  if (m) {
    const parts = m[1]!.split(',').map(p => p.trim())
    if (parts.length >= 3) {
      const chan = (p: string): number => {
        const n = parseFloat(p)
        return p.includes('%') ? n / 100 : n / 255
      }
      const rgb: [number, number, number] = [chan(parts[0]!), chan(parts[1]!), chan(parts[2]!)]
      if (rgb.every(c => Number.isFinite(c))) return rgb
    }
  }
  return null
}

/** Pull the host-applicable fields out of a Mapbox style's top-level
 *  `light` block (constant forms only — expression-valued fields are
 *  skipped). Returns null when there is nothing to apply. */
export function extractMapboxLight(style: unknown): MapboxLightOptions | null {
  if (style === null || typeof style !== 'object') return null
  const light = (style as { light?: unknown }).light
  if (light === null || typeof light !== 'object' || Array.isArray(light)) return null
  const l = light as { position?: unknown; intensity?: unknown; color?: unknown }
  const out: MapboxLightOptions = {}
  if (Array.isArray(l.position) && l.position.length === 3
      && l.position.every(n => typeof n === 'number' && Number.isFinite(n))) {
    out.position = [l.position[0] as number, l.position[1] as number, l.position[2] as number]
  }
  if (typeof l.intensity === 'number' && Number.isFinite(l.intensity)) out.intensity = l.intensity
  if (typeof l.color === 'string') {
    const rgb = parseCssRGB(l.color)
    if (rgb) out.color = rgb
  }
  return (out.position || out.intensity !== undefined || out.color) ? out : null
}
