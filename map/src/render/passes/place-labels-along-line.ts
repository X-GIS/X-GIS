// #727 P1 / LOC-ceiling extraction (#1003) — along-line label placement,
// split out of label-pass.ts (which was pinned against the shrink-only LOC
// ceiling) into its own module. Two exports:
//  - `placeLabelsAlongLine`: the pure screen-space placement walk, the single
//    authority for where along a projected polyline labels sit.
//  - `placeInlineLineLabels`: the Path-1 (inline / raw-GeoJSON) line-placement
//    body that projects a feature's own vertices and calls the walk above.
// Both are pure moves from label-pass.ts — same math, same emit order, no
// behavior change. Callers (label-pass.ts) pass in the closures/deps they
// already have (dpr, projectors, applyFeatureExprs, addLabel, dispatchIcon)
// rather than this module reaching into LabelPass internals.

import type { LabelDef } from '@xgis/compiler'
import type { GeoJSONFeature } from '@xgis/data'
import type { FeatureProps } from '../../text/text-resolver'

/** Walk an already-projected (screen-space, physical px) polyline and emit a
 *  label placement at each `symbol-spacing` stop — the single authority for
 *  where along a line labels sit. Both feature paths delegate here:
 *   - the vector-tile path's viewport-aligned line branch (a pure extraction —
 *     `emit` wraps its `emitLabelAlongSegment`, so the emitted labels are
 *     byte-identical), and
 *   - the inline / raw-GeoJSON line path (#727 P1), which previously collapsed
 *     a LineString to ONE horizontal centroid label.
 *
 *  Placement cadence (mirrors the historical viewport-aligned walk):
 *   - `spacingPx <= 0` (line-center) or a line shorter than half a spacing step
 *     → a SINGLE placement at the polyline midpoint (distance = total * 0.5);
 *   - otherwise → a placement every `spacingPx` from `spacingPx * 0.5`.
 *  `emit(pax, pay, pbx, pby, t)` receives the containing segment's projected
 *  endpoints and the fraction `t` along it; the caller derives the point and
 *  the screen-space tangent (so glyph rotation stays a caller concern). No
 *  emission when `pn < 2`. Exported for unit coverage — the callers are anon
 *  closures. */
export function placeLabelsAlongLine(
  px: Float32Array,
  py: Float32Array,
  pn: number,
  spacingPx: number,
  emit: (pax: number, pay: number, pbx: number, pby: number, t: number) => void,
): void {
  if (pn < 2) return
  let total = 0
  for (let i = 0; i < pn - 1; i++) {
    const dx = px[i + 1]! - px[i]!
    const dy = py[i + 1]! - py[i]!
    total += Math.sqrt(dx * dx + dy * dy)
  }
  // Single-label case: line-center (spacing 0) or a line too short to fit even
  // one spacing step → place once at the polyline midpoint.
  if (spacingPx <= 0 || total < spacingPx * 0.5) {
    let acc = 0
    const target = total * 0.5
    for (let i = 0; i < pn - 1; i++) {
      const dx = px[i + 1]! - px[i]!
      const dy = py[i + 1]! - py[i]!
      const segLen = Math.sqrt(dx * dx + dy * dy)
      if (acc + segLen >= target) {
        const t = segLen > 0 ? (target - acc) / segLen : 0
        emit(px[i]!, py[i]!, px[i + 1]!, py[i + 1]!, t)
        return
      }
      acc += segLen
    }
    return
  }
  let nextStop = spacingPx * 0.5
  let acc = 0
  for (let i = 0; i < pn - 1; i++) {
    const dx = px[i + 1]! - px[i]!
    const dy = py[i + 1]! - py[i]!
    const segLen = Math.sqrt(dx * dx + dy * dy)
    while (nextStop <= acc + segLen && nextStop <= total) {
      const t = segLen > 0 ? (nextStop - acc) / segLen : 0
      emit(px[i]!, py[i]!, px[i + 1]!, py[i + 1]!, t)
      nextStop += spacingPx
    }
    acc += segLen
  }
}

/** #727 P1 — inline (raw-GeoJSON) line placement. A symbol layer with
 *  symbol-placement: line / line-center over an inline LineString used to
 *  collapse to ONE horizontal centroid label (featureAnchor → lineMidpoint →
 *  a single addLabel). Project the feature's OWN vertices and delegate to the
 *  SAME along-line placement walk the vector-tile path uses
 *  (placeLabelsAlongLine), so it renders the tangent-rotated chain instead.
 *
 *  Caller (label-pass.ts Path 1) is responsible for the placement/geometry
 *  gate (`effectiveDef.placement === 'line' | 'line-center'` AND geometry is
 *  LineString/MultiLineString) — this function assumes that's already true
 *  and unconditionally treats `feat.geometry.coordinates` as line(s).
 *
 *  `applyFeatureExprs` / `projectLonLat` / `addLabel` / `dispatchIcon` are the
 *  host closures label-pass.ts already built for this ShowCommand — threaded
 *  through as params so this module stays free of LabelPass internals. */
export function placeInlineLineLabels(
  feat: GeoJSONFeature,
  effectiveDef: LabelDef,
  applyFeatureExprs: (props: FeatureProps) => LabelDef,
  projectLonLat: (lon: number, lat: number) => [number, number] | null,
  dpr: number,
  addLabel: (
    value: LabelDef['text'],
    props: FeatureProps,
    x: number,
    y: number,
    def: LabelDef,
    fontKey: string | undefined,
    layerName: string | undefined,
  ) => void,
  dispatchIcon: (
    def: LabelDef,
    ax: number,
    ay: number,
    lineTangentDeg: number,
    pairKey: string | undefined,
    collide: boolean,
    props: FeatureProps,
  ) => void,
  labelLayerName: string | undefined,
): void {
  // Caller (label-pass.ts Path 1) already skips null-geometry features
  // before reaching this call; re-assert it here so this module doesn't
  // depend on that external control flow for its own type narrowing.
  if (!feat.geometry) return
  const geomType = feat.geometry.type
  const props = feat.properties ?? {}
  const lineDef = applyFeatureExprs(props)
  // symbol-spacing is CSS px → physical px (×dpr); line-center
  // ignores spacing and always emits one label at the midpoint.
  const spacingCssPx = effectiveDef.placement === 'line' ? (effectiveDef.spacing ?? 0) : 0
  const spacingPx = spacingCssPx > 0 ? spacingCssPx * dpr : 0
  // text-rotation-alignment: viewport keeps labels upright; 'auto'
  // / 'map' (the default for line) follows the segment tangent.
  const useTangentRotation = (effectiveDef.rotationAlignment ?? 'auto') !== 'viewport'
  // Emit one placement at a projected segment position. Mirrors the
  // tile path's emitLabelAlongSegment text branch; the icon uses the
  // raw (unflipped) tangent, the text the upright-flipped angle.
  // pairKey / cross-tile dedup are tile-specific and intentionally
  // omitted for the single-feature inline path.
  const emitInlineLine = (pax: number, pay: number, pbx: number, pby: number, t: number): void => {
    const x = pax + (pbx - pax) * t
    const y = pay + (pby - pay) * t
    const rawTangentDeg = (Math.atan2(pby - pay, pbx - pax) * 180) / Math.PI
    if (useTangentRotation) {
      let angleDeg = rawTangentDeg
      if (angleDeg > 90 || angleDeg < -90) angleDeg += 180
      addLabel(
        lineDef.text,
        props,
        x,
        y,
        { ...lineDef, rotate: angleDeg },
        undefined,
        labelLayerName,
      )
    } else {
      addLabel(lineDef.text, props, x, y, lineDef, undefined, labelLayerName)
    }
    dispatchIcon(lineDef, x, y, rawTangentDeg, undefined, true, props)
  }
  // MultiLineString → each part independently; LineString → one.
  // Project vertices for the PRIMARY world copy (projectLonLat);
  // multi-copy line-label fan-out across ±360° is deferred (mirrors
  // the KNOWN GAP note on non-Mercator periodic label copies in label-pass.ts).
  const coords = (feat.geometry as { coordinates: unknown }).coordinates
  const parts: number[][][] =
    geomType === 'LineString' ? [coords as number[][]] : (coords as number[][][])
  for (const part of parts) {
    if (!Array.isArray(part) || part.length < 2) continue
    const px = new Float32Array(part.length)
    const py = new Float32Array(part.length)
    let pn = 0
    for (const v of part) {
      const p = projectLonLat(v[0]!, v[1]!)
      if (p) {
        px[pn] = p[0]
        py[pn] = p[1]
        pn++
      }
    }
    placeLabelsAlongLine(px, py, pn, spacingPx, emitInlineLine)
  }
}
