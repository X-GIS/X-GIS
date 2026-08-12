// Arrow show → GraphicsManager.addCompiledArrowLayer — the data-eval half of the
// DECLARATIVE `| arrow bearing-[.dir]` layer (#1302), mirroring heatmap-show.ts.
//
// Per-feature bearing (arrowBearingExpr, or the constant arrowBearing), size (the
// generic `size-[…]` → sizeExpr, or the constant size shape), and colour (the generic
// `fill` → fillColorExpr, or the constant fill) are evaluated ONCE here from the source
// Point features — the eval mirror of the SDF Point fork — then handed to the graphics
// manager, which packs the retained-arrow layout and draws through the shared arrow
// draper. Features come from the already-filtered FC the rebuild loop computed (the
// same features the sibling point/dots layer over this source reads).

import { evaluate, makeEvalProps, resolveColor } from '@xgis/compiler'
import type { Expr } from '@xgis/compiler'
import type { GeoJSONFeatureCollection } from '@xgis/data'
import type { ShowCommand } from './render/renderer-types'
import type { GraphicsManager } from './graphics/graphics-manager'
import { hexToRgba } from './feature-helpers'
import { resolveNumberShape } from './render/paint-shape-resolve'
import { warnPerFeatureColorUnresolved } from './render/per-feature-color-warning'

/** The slice of XGISMap the arrow show build reads. */
export interface ArrowShowHost {
  graphics: GraphicsManager
  camera: { zoom: number; pitch: number }
}

const DEFAULT_ARROW_SIZE = 16

/** Resolve the layer's constant/base arrow size (used for features whose size is NOT
 *  data-driven). Mirrors the Point fork's baseSize (paintShapes.circle.size, zoom-interp
 *  resolved when it is a shape rather than a constant). */
function baseArrowSize(show: ShowCommand, zoom: number): number {
  const s = show.paintShapes.circle.size
  if (s === null) return DEFAULT_ARROW_SIZE
  return s.kind === 'constant' ? s.value : resolveNumberShape(s, zoom, performance.now()).value
}

/** Build one `| arrow` show's compiled-arrow layer from the filtered Point FC. No-ops
 *  when the FC has no Point/MultiPoint features (geojson still streaming — a later
 *  rebuild re-adds). One arrow per point; a MultiPoint repeats its feature's values. */
export function addArrowShowLayer(
  host: ArrowShowHost,
  show: ShowCommand,
  filtered: GeoJSONFeatureCollection,
): void {
  const zoom = host.camera.zoom
  const pitch = host.camera.pitch
  // Cast `.ast` to the compiler Expr (the evaluate() param type) — the runtime
  // ShowCommand surfaces DataExpr.ast loosely across the workspace-package seam, so
  // this mirrors the Point fork's `show.sizeExpr.ast as import('@xgis/compiler').Expr`.
  const bearingAst = show.arrowBearingExpr?.ast as Expr | undefined
  const bearingConst = show.arrowBearing ?? 0
  const sizeAst = show.sizeExpr?.ast as Expr | undefined
  const sizeConst = baseArrowSize(show, zoom)
  const fillAst = show.fillColorExpr?.ast as Expr | undefined
  // #1666 — a MALFORMED layer constant (a ShowCommand carrying a non-hex `fill`) resolves
  // to null here, not to opaque black, so it lands on the same flat-white default as a
  // missing one. Black would have been a colour the author never wrote, reported as one
  // they did.
  const fillConst = hexToRgba(show.fill)

  const lons: number[] = []
  const lats: number[] = []
  const bearings: number[] = []
  const sizes: number[] = []
  const colors: [number, number, number, number][] = []

  for (const f of filtered.features) {
    const g = f.geometry
    if (!g || (g.type !== 'Point' && g.type !== 'MultiPoint')) continue

    // Per-feature eval (reserved keys injected; throw-isolated like the Point fork —
    // one pathological expression must not NaN the whole field).
    const bag = makeEvalProps({
      props: (f.properties ?? undefined) as Record<string, unknown> | undefined,
      geometryType: g.type,
      featureId: (f as { id?: string | number }).id,
      cameraZoom: zoom,
      cameraPitch: pitch,
    })
    let bearing = bearingConst
    if (bearingAst) {
      try {
        const r = evaluate(bearingAst, bag)
        if (typeof r === 'number') bearing = r
      } catch {
        /* keep the constant bearing */
      }
    }
    let size = sizeConst
    if (sizeAst) {
      try {
        const r = evaluate(sizeAst, bag)
        if (typeof r === 'number') size = r
      } catch {
        /* keep the base size */
      }
    }
    let color: [number, number, number, number] = fillConst
      ? [fillConst[0], fillConst[1], fillConst[2], fillConst[3]]
      : [1, 1, 1, 1]
    if (fillAst) {
      // Throw-isolated like the axes above — and, since #1664, the WARNING site too. A
      // data-driven `fill` leaves `show.fill` null by construction, so "keep the constant
      // colour" here means every arrow paints the flat white default: a wrong colour, not a
      // missing one, and the one failure the author most needs told about.
      let r: unknown
      try {
        r = evaluate(fillAst, bag)
      } catch (e) {
        r = e
      }
      // Mirror of the label path (render/passes/label-pass.ts): the token / CSS resolver
      // FIRST, then the parse. `hexToRgba` answers null for anything it does not recognise
      // (before #1666 its total twin answered opaque BLACK), so a non-hex string reaches
      // the warning instead of painting a wrong colour and reporting it as a right one.
      const c = typeof r === 'string' ? hexToRgba(resolveColor(r) ?? r) : null
      if (c) color = [c[0], c[1], c[2], c[3]]
      else warnPerFeatureColorUnresolved(show.layerName ?? show.targetName, 'fill', r)
    }

    if (g.type === 'Point') {
      lons.push(g.coordinates[0])
      lats.push(g.coordinates[1])
      bearings.push(bearing)
      sizes.push(size)
      colors.push(color)
    } else {
      for (const c of g.coordinates) {
        lons.push(c[0])
        lats.push(c[1])
        bearings.push(bearing)
        sizes.push(size)
        colors.push(color)
      }
    }
  }

  if (lons.length === 0) return
  host.graphics.addCompiledArrowLayer(
    Float64Array.from(lons),
    Float64Array.from(lats),
    Float32Array.from(bearings),
    Float32Array.from(sizes),
    colors,
  )
}
