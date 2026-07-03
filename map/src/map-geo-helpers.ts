// Pure free functions used by XGISMap's run / data-load / rebuild paths.
// No `this`, no module state, no GPU coupling — extracted from map.ts so
// these utilities sit beside the other engine helpers rather than buried
// in the high-level orchestrator. Mirrors feature-helpers.ts in spirit.

import type { GeoJSONFeatureCollection } from '@xgis/data'
import type { XGISFontResource, FontTypographyMap } from './map-types'
import { xlog } from '@xgis/shared'

/** Filter the xgis source DSL's `type:` field down to the values
 *  `detectVectorTileFormat` understands. XGIS source `type` can also
 *  be 'raster' / 'geojson' / 'auto' / undefined / arbitrary user string,
 *  none of which are vector tile kinds — return undefined so the
 *  detector falls through to URL-extension sniffing. */
export function asVectorTileKind(
  t: string | undefined,
): 'pmtiles' | 'tilejson' | 'auto' | undefined {
  // Mapbox-style sources declare `type: vector`; treat that as `auto`
  // so the URL-based detector picks the right format. Without this
  // mapping, sources like Protomaps `type:vector, tiles:[".../{z}/{x}/{y}.mvt"]`
  // fell through to raster classification via `isTileTemplate(url)`
  // and rendered as empty tiles (user-reported 2026-05-16).
  if (t === 'vector') return 'auto'
  return t === 'pmtiles' || t === 'tilejson' || t === 'auto' ? t : undefined
}

/** Scene-level animation detection. `true` when ANY ShowCommand
 *  carries a per-frame time-driven property — the paint axes
 *  (opacity / fill / stroke / strokeWidth / size) on PaintShapes
 *  or the structural dashOffsetShape. Drives the render loop's
 *  continuous-redraw decision: a static scene renders once and
 *  idles; an animated scene requestAnimationFrame's every tick. */
export function sceneHasAnyAnimation(
  shows: {
    paintShapes: import('@xgis/compiler').PaintShapes
    dashOffsetShape?: import('@xgis/compiler').PropertyShape<number> | null
  }[],
): boolean {
  const isTimeAnimated = (k: string): boolean => k === 'time-interpolated' || k === 'zoom-time'
  return shows.some((s) => {
    const p = s.paintShapes
    return (
      isTimeAnimated(p.common.opacity.kind) ||
      isTimeAnimated(p.line.strokeWidth.kind) ||
      (p.fill.fill !== null && isTimeAnimated(p.fill.fill.kind)) ||
      (p.line.stroke !== null && isTimeAnimated(p.line.stroke.kind)) ||
      (p.circle.size !== null && isTimeAnimated(p.circle.size.kind)) ||
      (s.dashOffsetShape !== null &&
        s.dashOffsetShape !== undefined &&
        isTimeAnimated(s.dashOffsetShape.kind))
    )
  })
}

/** True when any ShowCommand's LABEL carries a per-frame time-driven shape
 *  (text-size / -color / -halo / -opacity / icon-size / -opacity / -color
 *  interpolated against the animation clock). The S16 label-prepare skip keys
 *  on a camera/canvas/tile signature that does NOT include the clock, so a
 *  time-animated label on a static-camera frame would otherwise be skipped and
 *  freeze. The render loop reads this to keep re-collating such scenes.
 *  zoom-interp label shapes are NOT counted — the skip signature includes zoom,
 *  so those re-prepare correctly on their own. */
export function labelsHaveTimeAnimation(
  shows: {
    label?: { shapes?: import('@xgis/compiler').LabelDef['shapes'] } | null
  }[],
): boolean {
  const isTimeAnimated = (
    s: import('@xgis/compiler').PropertyShape<unknown> | null | undefined,
  ): boolean => s != null && (s.kind === 'time-interpolated' || s.kind === 'zoom-time')
  return shows.some((s) => {
    const sh = s.label?.shapes
    if (!sh) return false
    return (
      isTimeAnimated(sh.textLayout.size) ||
      isTimeAnimated(sh.textPaint.color) ||
      isTimeAnimated(sh.textPaint.haloWidth) ||
      isTimeAnimated(sh.textPaint.haloColor) ||
      isTimeAnimated(sh.textPaint.haloBlur) ||
      isTimeAnimated(sh.textLayout.fontWeight) ||
      isTimeAnimated(sh.icon.iconSize) ||
      isTimeAnimated(sh.textPaint.opacity) ||
      isTimeAnimated(sh.icon.iconOpacity) ||
      isTimeAnimated(sh.icon.iconColor)
    )
  })
}

/** Walk every coordinate in a GeoJSON FeatureCollection and return
 *  the lon/lat bbox. Used by the Phase 5e VirtualPMTilesBackend
 *  attach path to pick a camera-fit position when the source has
 *  no external metadata (unlike PMTiles' `bounds` field). Returns
 *  null when the collection has no usable geometry. */
export function computeGeoJSONBounds(
  fc: GeoJSONFeatureCollection,
): [number, number, number, number] | null {
  let minLon = Infinity,
    minLat = Infinity
  let maxLon = -Infinity,
    maxLat = -Infinity
  const visit = (c: unknown): void => {
    if (!Array.isArray(c)) return
    // Coordinate pair: [lon, lat, ...]
    if (typeof c[0] === 'number' && typeof c[1] === 'number') {
      const lon = c[0] as number,
        lat = c[1] as number
      if (lon < minLon) minLon = lon
      if (lon > maxLon) maxLon = lon
      if (lat < minLat) minLat = lat
      if (lat > maxLat) maxLat = lat
      return
    }
    for (const inner of c) visit(inner)
  }
  for (const f of fc.features ?? []) {
    if (f.geometry) visit((f.geometry as { coordinates?: unknown }).coordinates)
  }
  if (!isFinite(minLon)) return null
  return [minLon, minLat, maxLon, maxLat]
}

export function buildTypographyMap(fonts: readonly XGISFontResource[]): FontTypographyMap | null {
  const map: FontTypographyMap = new Map()
  for (const f of fonts) {
    const ls = f.letterSpacingEm ?? 0
    const lh = f.lineHeightScale ?? 1
    if (ls === 0 && lh === 1) continue
    map.set(f.family, { letterSpacingEm: ls, lineHeightScale: lh })
  }
  return map.size > 0 ? map : null
}

/** Register a batch of fonts via the FontFace API, returning a promise
 *  that resolves once every face has finished loading. No-op (and
 *  resolved immediately) in environments without `document.fonts`. */
export async function registerFonts(fonts: readonly XGISFontResource[]): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts) return
  await Promise.all(
    fonts.map(async (f) => {
      try {
        const face = new FontFace(f.family, f.data as BufferSource, {
          weight: f.weight ?? 'normal',
          style: f.style ?? 'normal',
        })
        await face.load()
        document.fonts.add(face)
      } catch (e) {
        // One bad font shouldn't bring down the rest. Swallow + log so
        // the developer can spot it without crashing the page.
        xlog.warn(`[XGISMap] FontFace load failed for "${f.family}":`, e)
      }
    }),
  )
}
