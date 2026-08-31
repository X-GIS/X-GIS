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

/** Parse a CSS colour (hex / rgb()/rgba() / white|black) to straight-alpha RGBA 0..1.
 *  Light colour only needs an approximate tint, so this covers the common
 *  authored forms; returns null when unparseable. Alpha defaults to 1 for the
 *  forms that carry none, and is read from `#rrggbbaa` / `rgba(…)` where they do
 *  (T5 Phase 1 — the sky ramp's colours are alpha-bearing; `light` still takes
 *  only the first three channels). */
function parseCssRGBA(s: string): [number, number, number, number] | null {
  const str = s.trim().toLowerCase()
  if (str === 'white') return [1, 1, 1, 1]
  if (str === 'black') return [0, 0, 0, 1]
  const hex = str.match(/^#([0-9a-f]{3,8})$/)
  if (hex) {
    const h = hex[1]!
    const wide = h.length === 6 || h.length === 8
    if (h.length !== 3 && h.length !== 4 && !wide) return null
    const at = (i: number): number =>
      wide ? parseInt(h.slice(i * 2, i * 2 + 2), 16) / 255 : parseInt(h[i]! + h[i]!, 16) / 255
    const hasAlpha = h.length === 4 || h.length === 8
    return [at(0), at(1), at(2), hasAlpha ? at(3) : 1]
  }
  const m = str.match(/^rgba?\(([^)]+)\)$/)
  if (m) {
    const parts = m[1]!.split(',').map((p) => p.trim())
    if (parts.length >= 3) {
      const chan = (p: string): number => {
        const n = parseFloat(p)
        return p.includes('%') ? n / 100 : n / 255
      }
      const rgba: [number, number, number, number] = [
        chan(parts[0]!),
        chan(parts[1]!),
        chan(parts[2]!),
        // CSS alpha is already 0..1 (or a percentage) — NOT a 0..255 channel.
        parts.length >= 4 ? parseAlpha(parts[3]!) : 1,
      ]
      if (rgba.every((c) => Number.isFinite(c))) return rgba
    }
  }
  return null
}

function parseAlpha(p: string): number {
  const n = parseFloat(p)
  return p.includes('%') ? n / 100 : n
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
  if (
    Array.isArray(l.position) &&
    l.position.length === 3 &&
    l.position.every((n) => typeof n === 'number' && Number.isFinite(n))
  ) {
    out.position = [l.position[0] as number, l.position[1] as number, l.position[2] as number]
  }
  if (typeof l.intensity === 'number' && Number.isFinite(l.intensity)) out.intensity = l.intensity
  if (typeof l.color === 'string') {
    const rgba = parseCssRGBA(l.color)
    // `light` is a lighting rig, not a compositing layer — it has no alpha channel, so the
    // parsed alpha is dropped here rather than plumbed anywhere.
    if (rgba) out.color = [rgba[0], rgba[1], rgba[2]]
  }
  return out.position || out.intensity !== undefined || out.color ? out : null
}

// ═══ MapLibre style-spec `sky` root → XGISMap.setAtmosphere({ sky }) (#2052 T5 Phase 1) ═══
//
// Host-applied exactly like `light` above: the xgis DSL carries no sky state, so the
// demo-runner + compare-runner read the raw block and call setAtmosphere. This phase
// carries the ZENITH-ANGLE RAMP only — `sky-color` (overhead), `horizon-color` (at the
// horizon; on the globe arm, the sphere limb) and `sky-horizon-blend` (the ramp width).
// `fog-color` / `fog-ground-blend` / `horizon-fog-blend` (the below-horizon band) and
// `atmosphere-blend` (the global zoom fade) are later phases and are warned about by the
// converter, not silently swallowed here.
//
// CONSTANT FORMS ONLY, same rule as extractMapboxLight: every one of these properties may
// be a zoom expression in a real style, and resolving those is the converter's expression
// machinery, not this extractor's job. An expression-valued property is left out, so the
// runtime default for it stands.

export interface MapboxSkyOptions {
  color?: [number, number, number, number]
  horizonColor?: [number, number, number, number]
  horizonBlend?: number
}

/** Pull the host-applicable fields out of a MapLibre style's top-level `sky` block.
 *  Returns null when the block is absent or carries none of them — the caller must then
 *  leave the sky OFF rather than enable it with all-default colours, which is what keeps a
 *  style that authors no sky byte-identical. */
export function extractMapboxSky(style: unknown): MapboxSkyOptions | null {
  if (style === null || typeof style !== 'object') return null
  const sky = (style as { sky?: unknown }).sky
  if (sky === null || typeof sky !== 'object' || Array.isArray(sky)) return null
  const s = sky as Record<string, unknown>
  const out: MapboxSkyOptions = {}
  const color = typeof s['sky-color'] === 'string' ? parseCssRGBA(s['sky-color']) : null
  if (color) out.color = color
  const horizon = typeof s['horizon-color'] === 'string' ? parseCssRGBA(s['horizon-color']) : null
  if (horizon) out.horizonColor = horizon
  const blend = s['sky-horizon-blend']
  if (typeof blend === 'number' && Number.isFinite(blend)) out.horizonBlend = blend
  return out.color || out.horizonColor || out.horizonBlend !== undefined ? out : null
}
