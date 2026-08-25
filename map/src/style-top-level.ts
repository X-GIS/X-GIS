// ═══ Top-level style ROOTS — `background`, `light`, `sky`/atmosphere (#2052) ═══
//
// A style has two kinds of statement: LAYERS (a `show` of some source, lowered through the
// whole compile → emit → draw spine) and ROOTS — the handful of top-level blocks that
// configure the scene itself and land straight on host fields the render host reads each
// frame. `background { fill: … }`, Mapbox `light`, and the MapLibre-ish atmosphere/`sky`
// are all roots: none of them is a layer, none goes through `emitCommands`, and each is
// nothing but "validate the authored value, write the field".
//
// That family lived inline in map.ts, which is the composition root and has no LOC headroom
// (`loc-ceiling-ratchet.test.ts`). This module owns the VALIDATION + PARSE half — the part
// that is pure policy over an authored value — and map.ts keeps the `this`-coupled wiring it
// alone can write: the `_destroyed` guard, the private `_dirty` tag, and `invalidate()`.
// Same split as coverage-refresh.ts / coverage-arm.ts, and the same reason.
//
// EXTRACTION ONLY (#2052 / T5 Phase 0): every body below moved out of map.ts unchanged.
// No validation was tightened, no default was altered, no side effect was reordered.
//
// NOT here: `setBackgroundFill`. Its body is `this`-coupled to map.ts PRIVATE members
// (`_syntheticBackend`, `_installSyntheticEarthSurfaceSource`) plus `showCommands` /
// `rawDatasets` / `underOccluder` teardown, so moving it would mean widening two private
// members — a surface change this phase is not allowed to make. Its style-side authority,
// the `background` block parse, is here; its host-lifecycle half stays in map.ts.

import { Lexer, Parser, resolveUtilities, resolveColor } from '@xgis/compiler'
import { extractInterpolateZoomColorStops, extractInterpolateZoomStops } from '@xgis/compiler'
import { hexToRgba } from './feature-helpers'
import {
  ATMOSPHERE_DEFAULT_INNER_COLOR,
  ATMOSPHERE_DEFAULT_OUTER_COLOR,
} from './render/atmosphere-uniform'
import type * as AST from '@xgis/compiler'

/** Top-level fill-extrusion light state (Mapbox `light`), as the render host reads it.
 *  Single authority for the shape of `XGISMap._light`. */
export interface TopLevelLight {
  position: [number, number, number]
  intensity: number
  color: [number, number, number]
}

/** The patch `setLight` accepts — every field optional, omitted fields keep their
 *  current value. Single authority for `XGISMap.setLight`'s parameter shape. */
export interface TopLevelLightPatch {
  position?: [number, number, number]
  intensity?: number
  color?: [number, number, number]
}

/** Top-level atmosphere/sky state (#1258), as the render host reads it. Single authority
 *  for the shape of `XGISMap._atmosphere`. */
export interface TopLevelAtmosphere {
  innerColor: [number, number, number, number]
  outerColor: [number, number, number, number]
}

/** The patch `setAtmosphere` accepts — an omitted colour falls back to the MapLibre-ish
 *  default for that colour (NOT to the current value; that asymmetry with
 *  `TopLevelLightPatch` is #1258's behaviour and is preserved verbatim). */
export interface TopLevelAtmospherePatch {
  innerColor?: [number, number, number, number]
  outerColor?: [number, number, number, number]
}

/** The slice of XGISMap the top-level roots write. Every member is non-private by the
 *  underscore convention precisely because the render host reads it each frame. */
export interface TopLevelStyleHost {
  _light: TopLevelLight
  _atmosphere: TopLevelAtmosphere | null
  _backgroundColor: [number, number, number, number] | null
  _backgroundColorShape:
    import('@xgis/compiler').PropertyShape<readonly [number, number, number, number]> | null
  _backgroundOpacityShape: import('@xgis/compiler').PropertyShape<number> | null
  _backgroundPattern: string | null
}

/** WS-1 — true when a background `fill:` / `opacity:` style-property value
 *  is a zoom interpolate call (the converter emits these for Mapbox
 *  `["interpolate", …, ["zoom"], …]` background paints). The constant
 *  hex / named-colour / numeric forms don't start with this prefix and
 *  fall through to the legacy constant path. */
function isInterpolateString(raw: string): boolean {
  return raw.startsWith('interpolate(') || raw.startsWith('interpolate_exp(')
}

/** WS-1 — lex+parse a `interpolate(zoom, …)` style-property string back
 *  into the FnCall AST.Expr so the compiler's stop extractors can pull
 *  its (zoom, value) stops. The converter captured the call as a single
 *  string (parser.captureFnCallAsString); re-parse it as a single
 *  expression (`parseSingleExpression` — no version pragma, no
 *  statement grammar). Returns null on any parse failure so the caller
 *  falls through to the constant path instead of throwing on a
 *  malformed value. */
function parseFillInterpolate(raw: string): AST.Expr | null {
  try {
    return new Parser(new Lexer(raw).tokenize()).parseSingleExpression()
  } catch {
    return null
  }
}

/** WS-9 — validate a `light` patch onto the host's `_light`. `null` resets to the Mapbox
 *  default; otherwise each well-formed field is adopted and each malformed one is IGNORED
 *  (keeping the current value), which is why this is per-field rather than all-or-nothing.
 *  Caller owns the dirty tag + invalidate. */
export function applyLight(host: TopLevelStyleHost, light: TopLevelLightPatch | null): void {
  if (light === null) {
    host._light = { position: [1.15, 210, 30], intensity: 0.5, color: [1, 1, 1] }
  } else {
    if (
      Array.isArray(light.position) &&
      light.position.length === 3 &&
      light.position.every((n) => Number.isFinite(n))
    ) {
      host._light.position = [light.position[0]!, light.position[1]!, light.position[2]!]
    }
    if (typeof light.intensity === 'number' && Number.isFinite(light.intensity)) {
      host._light.intensity = Math.max(0, Math.min(1, light.intensity))
    }
    if (
      Array.isArray(light.color) &&
      light.color.length === 3 &&
      light.color.every((n) => Number.isFinite(n))
    ) {
      host._light.color = [light.color[0]!, light.color[1]!, light.color[2]!]
    }
  }
}

/** #1258 — validate an atmosphere patch onto the host's `_atmosphere`. `null` turns the
 *  pass OFF; otherwise a malformed colour falls back to that colour's default rather than
 *  to the current value. Both colours are COPIED (`[...inner]`) so a caller mutating the
 *  array it passed in cannot reach into host state. Caller owns the destroyed guard, the
 *  dirty tag + invalidate. */
export function applyAtmosphere(
  host: TopLevelStyleHost,
  atmosphere: TopLevelAtmospherePatch | null,
): void {
  if (atmosphere === null) {
    host._atmosphere = null
  } else {
    const inner =
      Array.isArray(atmosphere.innerColor) &&
      atmosphere.innerColor.length === 4 &&
      atmosphere.innerColor.every((n) => Number.isFinite(n))
        ? atmosphere.innerColor
        : ATMOSPHERE_DEFAULT_INNER_COLOR
    const outer =
      Array.isArray(atmosphere.outerColor) &&
      atmosphere.outerColor.length === 4 &&
      atmosphere.outerColor.every((n) => Number.isFinite(n))
        ? atmosphere.outerColor
        : ATMOSPHERE_DEFAULT_OUTER_COLOR
    host._atmosphere = { innerColor: [...inner], outerColor: [...outer] }
  }
}

/** Parse the style's `background { … }` root onto the host's four background fields.
 *  Called once per style program load, BEFORE the synthetic earth-surface install reads
 *  `_backgroundColor` — the resets at the top are what make a re-run() with a
 *  constant-background style drop a previous style's zoom-interp shapes. */
export function parseBackgroundBlock(host: TopLevelStyleHost, ast: AST.Program): void {
  // background { fill: <color> } — Mapbox-style earth-surface fill. Phase 2 PR 2c.3 ships this
  // through the standard polygon ECEF pipeline (SyntheticEarthSurfaceBackend serves a z=0
  // lat/lon-grid mesh projected to ECEF; the synthetic ShowCommand prepended to `commands.shows`
  // carries the fill paint). Sphere projections see the fill curve naturally; flat projections
  // see the band fill at sort-order 0 just like the legacy BackgroundRenderer path. Color lookup:
  // utility lines first (`| fill-sky-900` → resolveUtilities → hex), then style properties
  // (`fill: sky-900` or `fill: #082f49`). StyleProperty stores the raw string; `sky-900` resolves
  // via resolveColor(); bare `#rrggbb` passes through. WS-1 — reset the per-frame zoom-interp
  // background shapes before the parse so a re-run() with a CONSTANT background clears a stale
  // shape left by a previous zoom-interp style (the constant path below sets `_backgroundColor`
  // but never touches these).
  host._backgroundColorShape = null
  host._backgroundOpacityShape = null
  // #777 I-E — reset the background pattern before the parse (mirror of the
  // shape resets) so a re-run() with a pattern-less style clears a stale name.
  host._backgroundPattern = null
  let bgColor: string | null = null
  for (const stmt of ast.body) {
    if (stmt.kind !== 'BackgroundStatement') continue
    const items: AST.UtilityItem[] = []
    for (const line of stmt.utilities) items.push(...line.items)
    const resolved = resolveUtilities(items)
    let color: string | null = resolved.fill ?? null
    for (const sp of stmt.styleProperties) {
      const raw = sp.value
      if (sp.name === 'fill') {
        // WS-1 — a zoom-interp `fill: interpolate(zoom, …)` (emitted by
        // the converter for `["interpolate", …, ["zoom"], …]` colours)
        // lexes back into a colour shape resolved per frame. Constant
        // hex / named colours keep the legacy `_backgroundColor` path.
        const expr = isInterpolateString(raw) ? parseFillInterpolate(raw) : null
        const colorInterp = expr ? extractInterpolateZoomColorStops(expr) : null
        if (colorInterp && colorInterp.stops.length > 0) {
          const stops: { zoom: number; value: readonly [number, number, number, number] }[] = []
          for (const s of colorInterp.stops) {
            const rgba = hexToRgba(s.value)
            if (rgba !== null) stops.push({ zoom: s.zoom, value: rgba })
          }
          if (stops.length > 0) {
            host._backgroundColorShape =
              colorInterp.base !== 1
                ? { kind: 'zoom-interpolated', stops, base: colorInterp.base }
                : { kind: 'zoom-interpolated', stops }
          }
        } else if (raw.startsWith('#')) {
          color = raw
        } else {
          const hex = resolveColor(raw)
          if (hex) color = hex
        }
      } else if (sp.name === 'opacity') {
        // WS-1 — a zoom-interp `opacity: interpolate(zoom, …)` (0..100
        // stops, like circle-opacity). Build a PropertyShape<number> in
        // 0..1 the background pass multiplies into the clear alpha.
        const expr = isInterpolateString(raw) ? parseFillInterpolate(raw) : null
        const opInterp = expr ? extractInterpolateZoomStops(expr) : null
        if (opInterp && opInterp.stops.length > 0) {
          const stops = opInterp.stops.map((s) => ({ zoom: s.zoom, value: s.value / 100 }))
          host._backgroundOpacityShape =
            opInterp.base !== 1
              ? { kind: 'zoom-interpolated', stops, base: opInterp.base }
              : { kind: 'zoom-interpolated', stops }
        }
      } else if (sp.name === 'pattern') {
        // #777 I-E — `pattern: <sprite>` (the converter's constant
        // background-pattern lowering). The raw value is the sprite name the
        // background pass looks up in the sprite atlas; a blank name leaves
        // the pattern null (clear-only).
        host._backgroundPattern = raw.length > 0 ? raw : null
      }
    }
    if (color) bgColor = color
  }
  // An invalid hex shape falls through to the renderer's built-in
  // default instead of silently painting black: hexToRgba's null
  // surfaces the bad input as "no override" rather than "opaque
  // black background". (Until #1666 the null-returning helper had a
  // total twin that answered [0, 0, 0, 1] here; there is now one
  // function and this is its only behaviour.)
  if (bgColor) {
    const parsed = hexToRgba(bgColor)
    if (parsed !== null) host._backgroundColor = parsed
  }
  // A zoom-interp background-color has no constant `_backgroundColor`.
  // Seed it from the first stop so the synthetic earth-surface install
  // (sphere path) + the pre-frame clear have a sensible static colour
  // before the first per-frame resolve, and so the existing
  // `if (this._backgroundColor)` install gates still fire.
  if (host._backgroundColor === null && host._backgroundColorShape !== null) {
    const first =
      host._backgroundColorShape.kind === 'zoom-interpolated'
        ? host._backgroundColorShape.stops[0]?.value
        : undefined
    if (first) host._backgroundColor = [first[0], first[1], first[2], first[3]]
  }
}
