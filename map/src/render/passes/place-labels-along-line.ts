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
import { lineIconIsIconOnly } from './line-label-dedupe'

/** Mapbox `symbol-spacing` → the on-screen (physical px) step between along-line
 *  placements. The single authority for both line paths.
 *
 *  The spacing is NOT a screen-space constant. MapLibre lays symbols out in TILE
 *  units — `symbol-spacing × EXTENT / (512 × overscaling)` — inside a bucket built
 *  for the covering integer zoom, and then the map scales that bucket. So the
 *  step a viewer measures is `symbol-spacing × 2^(zoom − overscaledZ)`, and since
 *  every tile of a source shares one covering zoom (`floor(zoom)`), that is
 *  `symbol-spacing × 2^frac(zoom)`: shields sit one spacing apart at an integer
 *  zoom and drift to nearly two by the top of the step, snapping back at the next
 *  crossing. X-GIS walks the polyline in SCREEN space, so the tile-unit bake has
 *  to be reintroduced here or the chain stays a flat `symbol-spacing` and renders
 *  denser than the reference everywhere except exact integer zooms.
 *
 *  Verified against MapLibre GL JS on OFM Positron `highway-shield-non-us`
 *  (symbol-spacing 200) over a zoom sweep at 37.79172/126.79102 — measured /
 *  predicted = 0.999, 0.998, 1.000, 1.001, 1.001 at z16.0/16.2/16.5/16.7/16.9.
 *
 *  Returns 0 for a non-positive spacing (line-center, or an unset value), which
 *  both callers read as "one placement at the polyline midpoint". */
export function lineLabelSpacingPx(spacingCssPx: number, dpr: number, zoom: number): number {
  if (!(spacingCssPx > 0)) return 0
  const base = spacingCssPx * dpr
  // A non-finite zoom would poison the step into NaN and silently collapse the
  // chain to a single midpoint label; fall back to the unscaled step instead.
  if (!Number.isFinite(zoom)) return base
  return base * 2 ** (zoom - Math.floor(zoom))
}

/** #1314 — fallback line-label viewport edge inset (CSS px, scaled by dpr at use).
 *  Sized at roughly half a typical road-label width: comfortable enough that the
 *  shaped glyph run clears the edge, small enough that it doesn't drop labels that
 *  are perfectly readable inboard. Used when the label's own extent is unknown. */
export const LINE_LABEL_EDGE_INSET_CSS_PX = 48

/** #1314 viewport edge inset for one line label, in physical px.
 *
 *  The cull exists so a line label never renders glued half-off-screen ("화면
 *  기준 양 끝으로 라벨이 붙어서 가시성 및 가독성이 나빠지는"). What it should
 *  actually test is whether the label's OWN extent clears the edge — a constant
 *  is only a stand-in for a width we cannot know before shaping.
 *
 *  For a PAIRED symbol we can: a route shield's extent IS its badge sprite, known
 *  here. Using the constant for those over-culled them roughly 4× — at
 *  #16.7/37.79172/126.79102 MapLibre draws a shield 22 px from the edge, fully
 *  legible, while the 48 px constant dropped it. Its own half-extent (~12 px)
 *  keeps it and still clips nothing.
 *
 *  Unpaired text keeps the constant: its width is not known at cull time, and a
 *  conservative estimate is the whole point of #1314. `sprite` undefined (no
 *  icon, unresolved name, no atlas) ⇒ the constant. */
export function lineLabelEdgeInsetPx(
  def: { iconImage?: string | null; iconSize?: number },
  spriteOf: (name: string) => { width: number; height: number; pixelRatio: number } | undefined,
  dpr: number,
): number {
  const name = def.iconImage
  const sprite = name !== undefined && name !== null && name !== '' ? spriteOf(name) : undefined
  if (sprite === undefined) return LINE_LABEL_EDGE_INSET_CSS_PX * dpr
  const size = def.iconSize !== undefined && def.iconSize > 0 ? def.iconSize : 1
  return (Math.max(sprite.width, sprite.height) / sprite.pixelRatio / 2) * size * dpr
}

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
 *   - otherwise → a placement every `spacingPx` from `spacingPx * 0.5`, or from
 *     `phasePx` when the caller supplies a world-anchored origin (see below).
 *  `emit(pax, pay, pbx, pby, t)` receives the containing segment's projected
 *  endpoints and the fraction `t` along it; the caller derives the point and
 *  the screen-space tangent (so glyph rotation stays a caller concern). No
 *  emission when `pn < 2`. Exported for unit coverage — the callers are anon
 *  closures.
 *
 *  `phasePx` (INC-1 of docs/plans/2026-07-27-line-label-world-anchored-placement.md)
 *  is the along-polyline screen offset of a WORLD anchor — MapLibre's chain sits at
 *  `tileEntry + k · spacing`, so the offset the caller computes is the tile-entry
 *  crossing measured from `px[0]`. It may be negative (the anchor lies behind the
 *  start of the projected run) or larger than one step; only its residue mod
 *  `spacingPx` matters, since the emitted set `{phase + k·spacing} ∩ [0, total]` is
 *  invariant under adding whole steps. That residue is what makes the chain
 *  pan-invariant: the same road labels at the same world positions no matter where
 *  the visible run happens to start. Undefined ⇒ the historical `spacingPx * 0.5`. */
export function placeLabelsAlongLine(
  px: Float32Array,
  py: Float32Array,
  pn: number,
  spacingPx: number,
  emit: (pax: number, pay: number, pbx: number, pby: number, t: number) => void,
  cull?: (px: number, py: number) => boolean,
  phasePx?: number,
): void {
  if (pn < 2) return
  // #1314 — optional viewport edge-inset cull. A line label whose anchor projects
  // too close to a screen edge renders half-clipped and unreadable (user report:
  // "화면 기준 양 끝으로 라벨이 붙어서 가시성 및 가독성이 나빠지는"). When `cull` is
  // supplied it receives the interpolated anchor point and returns true to KEEP;
  // a false verdict skips this stop and the walk continues to the next. Undefined
  // ⇒ every stop emits (the historical behaviour — inline / raw-GeoJSON path).
  const emitK =
    cull === undefined
      ? emit
      : (pax: number, pay: number, pbx: number, pby: number, t: number): void => {
          if (cull(pax + (pbx - pax) * t, pay + (pby - pay) * t)) emit(pax, pay, pbx, pby, t)
        }
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
        emitK(px[i]!, py[i]!, px[i + 1]!, py[i + 1]!, t)
        return
      }
      acc += segLen
    }
    return
  }
  let nextStop = lineLabelFirstStopPx(phasePx, spacingPx)
  let acc = 0
  for (let i = 0; i < pn - 1; i++) {
    const dx = px[i + 1]! - px[i]!
    const dy = py[i + 1]! - py[i]!
    const segLen = Math.sqrt(dx * dx + dy * dy)
    while (nextStop <= acc + segLen && nextStop <= total) {
      const t = segLen > 0 ? (nextStop - acc) / segLen : 0
      emitK(px[i]!, py[i]!, px[i + 1]!, py[i + 1]!, t)
      nextStop += spacingPx
    }
    acc += segLen
  }
}

/** Where the first along-line stop sits, given a world anchor. The single authority
 *  for the world lattice: `placeLabelsAlongLine` (viewport-aligned branch, INC-1) and
 *  label-pass.ts's curved walk (INC-2) both call it, so the two branches cannot drift
 *  into different phases for the same road.
 *
 *  Folds the anchor into `[0, spacingPx)` — a residue, not the raw offset. The
 *  emitted set `{phase + k · spacing}` is unchanged by adding whole steps, so a run
 *  that starts far past the tile boundary (or, as is usual, before it) still lands on
 *  the same lattice. JS `%` keeps the sign of the dividend, hence the second fold: a
 *  raw `-160 % 200` would start the walk at a negative offset and emit a stop before
 *  the polyline begins.
 *
 *  An undefined or non-finite phase falls back to the historical `spacingPx * 0.5` —
 *  a NaN here would silently emit nothing at all. */
export function lineLabelFirstStopPx(phasePx: number | undefined, spacingPx: number): number {
  if (phasePx === undefined || !Number.isFinite(phasePx)) return spacingPx * 0.5
  return ((phasePx % spacingPx) + spacingPx) % spacingPx
}

/** INC-2 of docs/plans/2026-07-27-line-label-world-anchored-placement.md — map a
 *  WORLD offset (mercator arc-length from the polyline's vertex 0) to the along-
 *  SCREEN offset of the same point, measured from the projected run's first sample.
 *
 *  Both line branches walk in screen space but anchor in the world, so something has
 *  to cross between the two frames. Scaling by a single `pxPerMeter` is only right
 *  where that ratio is constant across the run — it is not under pitch (the far end
 *  of a road compresses) nor over a long low-zoom polyline. This is the honest
 *  version: the projection loop already visits every sample, so it can accumulate
 *  mercator arc-length alongside the projected points, and the conversion becomes a
 *  lookup in the two parallel prefix sums. O(n) over samples we already have.
 *
 *  `pm[i]` is the mercator arc-length from vertex 0 to sample `i` — monotone
 *  non-decreasing, and NOT generally 0 at `i = 0` (leading samples that failed to
 *  project are dropped, so the retained run can start mid-polyline).
 *
 *  The result may be negative: the tile-entry anchor usually sits BEHIND the first
 *  retained sample, which is exactly the case a plain `arc - pm[0]` scaling gets
 *  wrong. Targets outside `[pm[0], pm[pn-1]]` extrapolate along the nearest
 *  interval's screen-per-mercator ratio rather than clamping — clamping would
 *  collapse every off-run anchor onto the endpoint and quantise the phase to 0.
 *
 *  Returns 0 when there is nothing to interpolate (`pn < 2`) or the containing
 *  interval has zero mercator extent (a degenerate duplicate sample). */
export function mercOffsetToScreenOffset(
  px: Float32Array,
  py: Float32Array,
  pm: Float64Array,
  pn: number,
  targetM: number,
): number {
  if (pn < 2) return 0
  let screenAcc = 0
  for (let i = 0; i < pn - 1; i++) {
    const dm = pm[i + 1]! - pm[i]!
    const ds = Math.hypot(px[i + 1]! - px[i]!, py[i + 1]! - py[i]!)
    // Last interval doubles as the extrapolation arm for targets past the end.
    if (targetM <= pm[i + 1]! || i === pn - 2) {
      if (!(dm > 0)) return screenAcc
      return screenAcc + ds * ((targetM - pm[i]!) / dm)
    }
    screenAcc += ds
  }
  return screenAcc
}

/** Point + tangent at along-polyline screen offset `s` on an already-projected
 *  (physical px) polyline. Writes `[x, y, tangentDeg, segIdx, segT]` into `out` (a
 *  caller-owned holder — this runs once per spacing stop, so returning a fresh
 *  object showed up in the hot loop) and returns false when `s` runs past the
 *  polyline's end. Slots 3-4 are the CORRESPONDENCE itself (see below): the
 *  containing segment and the fraction into it, so a caller holding a THIRD array
 *  parallel to the run (the label pass holds the samples' mercator metres) can
 *  read its own value at the same place without walking the run again.
 *
 *  The tangent is the containing segment's direction in degrees CCW from +x;
 *  `icon-rotation-alignment: map` (OFM road_oneway arrows) rotates by it.
 *
 *  Moved out of label-pass.ts's curved branch to sit beside the placement walk that
 *  shares its geometry — the two are the same "where along this polyline" question.
 *
 *  THE INDEX CORRESPONDENCE (#2012 INC-4, design §3.4(3)). Under
 *  `text-pitch-alignment: map` the curved branch walks the LABEL PLANE — the
 *  pitch-0 image of the same polyline — so the cadence is uniform in the space
 *  MapLibre lays out in instead of uniform on a foreshortened screen. `twinX` /
 *  `twinY` are that walk's LIVE screen twin: the second projection of the SAME
 *  retained samples, so index `i` names one ground point in both arrays BY
 *  CONSTRUCTION (the plane run is filled from the live run's own merc samples,
 *  and the whole run is abandoned if any sample has no pitch-0 image). The
 *  offset `s` is then measured on `px`/`py` and the point + tangent are READ OFF
 *  the twin: `lerp(twin[i], twin[i+1], t)` — no inverse, no extra projection, and
 *  exact at every sample rather than to first order. Absent (every viewport-
 *  aligned label, every unpitched frame) → the twin IS `px`/`py` and the walk is
 *  byte-identical to what it always did. */
export function sampleAlongPolyline(
  px: Float32Array,
  py: Float32Array,
  pn: number,
  s: number,
  out: [number, number, number, number, number],
  twinX?: Float32Array,
  twinY?: Float32Array,
): boolean {
  const qx = twinX ?? px
  const qy = twinY ?? py
  let acc = 0
  for (let i = 0; i < pn - 1; i++) {
    const dx = px[i + 1]! - px[i]!
    const dy = py[i + 1]! - py[i]!
    const segLen = Math.sqrt(dx * dx + dy * dy)
    if (acc + segLen >= s) {
      const t = segLen > 0 ? (s - acc) / segLen : 0
      const qdx = qx[i + 1]! - qx[i]!
      const qdy = qy[i + 1]! - qy[i]!
      out[0] = qx[i]! + qdx * t
      out[1] = qy[i]! + qdy * t
      out[2] = (Math.atan2(qdy, qdx) * 180) / Math.PI
      out[3] = i
      out[4] = t
      return true
    }
    acc += segLen
  }
  return false
}

/** Everything the per-stop emitter needs from the ShowCommand being dispatched.
 *  Bundled rather than passed positionally: there are nine of them, and a
 *  positional list of nine closures is a swap waiting to happen.
 *
 *  `nextPairSeq` is a FUNCTION, not a number — the paired-symbol sequence counter
 *  is shared with label-pass.ts's curved branch, and copying its value here would
 *  fork it into two counters that hand out the same keys. */
export interface EmitLabelAlongSegmentDeps {
  applyFeatureExprs: (props: FeatureProps) => LabelDef
  addLabel: (
    value: LabelDef['text'],
    props: FeatureProps,
    x: number,
    y: number,
    def: LabelDef,
    fontKey: string | undefined,
    layerName: string | undefined,
    pairKey: string | undefined,
  ) => void
  dispatchIcon: (
    def: LabelDef,
    ax: number,
    ay: number,
    lineTangentDeg: number,
    pairKey: string | undefined,
    collide: boolean,
    props: FeatureProps,
  ) => void
  /** #603 — bucketed screen-position gate for text-less line icons. */
  isLineIconDuplicate: (x: number, y: number) => boolean
  /** Monotonic per-anchor counter behind the paired-symbol key (iter-176). */
  nextPairSeq: () => number
  labelLayerName: string | undefined
  /** text-rotation-alignment !== 'viewport' — glyphs follow the segment tangent. */
  useTangentRotation: boolean
  zoom: number
}

/** One label placement at an interpolated point on a projected segment — the
 *  emit half of the vector-tile line path, paired with `placeLabelsAlongLine`
 *  which decides WHERE the stops are.
 *
 *  Extracted from label-pass.ts, which sits exactly on its shrink-only LOC
 *  ceiling: any further line-label work there (the drop-attribution counters this
 *  extraction pays for, and whatever comes after) needs the room. Pure move — the
 *  body, the order of the guards and the emitted labels are unchanged.
 *
 *  Returns the emitter rather than doing the work, because `placeLabelsAlongLine`
 *  wants a plain callback and the deps are fixed for the whole ShowCommand. */
export function makeEmitLabelAlongSegment(
  d: EmitLabelAlongSegmentDeps,
): (pax: number, pay: number, pbx: number, pby: number, t: number, props: FeatureProps) => void {
  return (pax, pay, pbx, pby, t, props) => {
    const x = pax + (pbx - pax) * t
    const y = pay + (pby - pay) * t
    // Raw segment tangent in degrees (CCW from +x). Icons with
    // icon-rotation-alignment=map use this directly (no upright flip); text uses
    // the flipped form so glyphs stay readable from the natural reading direction.
    const rawTangentDeg = (Math.atan2(pby - pay, pbx - pax) * 180) / Math.PI
    const featDef = d.applyFeatureExprs(props)
    // Iter 112 paired-symbol collision: a text label with a paired iconImage (OFM
    // highway-shield-* / road_shield_us at z>=11) is tied to its badge by a shared
    // per-anchor pairKey. TextStage.prepare runs collision and stamps
    // droppedPairKeys for any REJECTED text; IconStage.prepare drops icons whose
    // paired text was rejected. Matches MapLibre's "text+icon as one symbol"
    // invariant. Replaces iter 111's allowOverlap shortcut, which kept every
    // shield instance and produced visible duplication along single routes.
    const pairedWithIcon =
      featDef.iconImage !== undefined && featDef.iconImage !== null && featDef.iconImage !== ''
    const pairKey = pairedWithIcon ? `${d.labelLayerName ?? ''}:seq${d.nextPairSeq()}` : undefined
    // #603 — cross-tile dedup for text-less line icons. With no text (road_oneway
    // arrows) the text-name dedup doesn't gate the icon, and two tiles' polyline
    // walks can place icons at nearby but non-overlapping screen positions at a
    // seam. The predicate is the RESOLVED text being empty (lineIconIsIconOnly),
    // NOT `featDef.text === undefined`: an icon-only symbol emits text === '""'
    // (compiler symbol.ts labelExpr), so featDef.text is a non-null empty template
    // — the old undefined test was ALWAYS true and this dedup never fired (#603).
    if (
      lineIconIsIconOnly(featDef.text, props, d.zoom) &&
      pairedWithIcon &&
      d.isLineIconDuplicate(x, y)
    )
      return
    if (d.useTangentRotation) {
      let angleDeg = rawTangentDeg
      if (angleDeg > 90 || angleDeg < -90) angleDeg += 180
      // No fontKey override — TextStage.composeFontKey builds the proper CSS
      // shorthand with weight / italic / CJK fallback from featDef.
      d.addLabel(
        featDef.text,
        props,
        x,
        y,
        { ...featDef, rotate: angleDeg },
        undefined,
        d.labelLayerName,
        pairKey,
      )
    } else {
      // Viewport-aligned: place at the line position with the def's static
      // rotate (typically 0).
      d.addLabel(featDef.text, props, x, y, featDef, undefined, d.labelLayerName, pairKey)
    }
    // Icon-along-line: same anchor + same pairKey as the label. OFM
    // highway-shield-* wants the badge + text to place/drop together. The
    // unflipped tangent feeds icon-rotation-alignment=map so road_oneway arrows
    // point along the road.
    d.dispatchIcon(featDef, x, y, rawTangentDeg, pairKey, true, props)
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
  cull: ((px: number, py: number) => boolean) | undefined,
  /** Camera zoom — the along-line step is zoom-dependent (lineLabelSpacingPx). */
  zoom: number,
): void {
  // Caller (label-pass.ts Path 1) already skips null-geometry features
  // before reaching this call; re-assert it here so this module doesn't
  // depend on that external control flow for its own type narrowing.
  if (!feat.geometry) return
  const geomType = feat.geometry.type
  const props = feat.properties ?? {}
  const lineDef = applyFeatureExprs(props)
  // line-center ignores spacing and always emits one label at the midpoint.
  const spacingCssPx = effectiveDef.placement === 'line' ? (effectiveDef.spacing ?? 0) : 0
  const spacingPx = lineLabelSpacingPx(spacingCssPx, dpr, zoom)
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
    // #1050 — a null projection is a HARD run break, not a skipped vertex: split
    // the part into contiguous visible runs and place each independently, so a
    // label never lands on a phantom chord bridging a horizon-culled gap. Each
    // run restarts the spacing walk (placeLabelsAlongLine no-ops when pn < 2, so
    // an empty / single-vertex run flushes harmlessly). The px/py buffer is
    // consumed synchronously per flush, so reusing it from index 0 is safe.
    let pn = 0
    const flushRun = (): void => {
      placeLabelsAlongLine(px, py, pn, spacingPx, emitInlineLine, cull)
      pn = 0
    }
    for (const v of part) {
      const p = projectLonLat(v[0]!, v[1]!)
      if (p) {
        px[pn] = p[0]
        py[pn] = p[1]
        pn++
      } else {
        flushRun()
      }
    }
    flushRun()
  }
}

/** #1314 — viewport edge-inset test for a line-label anchor. A line label placed
 *  along a viewport-clipped run drops a stop every `symbol-spacing` from wherever
 *  the road ENTERS the viewport — i.e. the first/last stops sit right at the two
 *  screen edges, rendering half-clipped and unreadable ("화면 기준 양 끝으로 라벨이
 *  붙어서 가시성 및 가독성이 나빠지는"). Returns true when the anchor `(sx, sy)`
 *  (physical px) sits INSIDE the `insetPx` margin (safe to place); false when it
 *  hugs an edge (cull). Line-CENTER labels anchor at the visible-run midpoint,
 *  which is structurally interior, so this rarely touches them — it targets the
 *  spacing chain's near-edge stops. Pure + exported for unit coverage. */
export function withinViewportInset(
  sx: number,
  sy: number,
  w: number,
  h: number,
  insetPx: number,
): boolean {
  return sx >= insetPx && sy >= insetPx && sx <= w - insetPx && sy <= h - insetPx
}
