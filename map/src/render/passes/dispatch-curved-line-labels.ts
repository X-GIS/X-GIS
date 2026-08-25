// ═══ #2012 INC-4 — curved line-label dispatch, and the label plane it walks ═══
//
// Extracted from `label-pass.ts` (which sat exactly at its LOC ceiling) for the
// same two reasons `dispatch-point-labels.ts` was extracted for #777 IV3: the
// ceiling is paid with a move that has its own reason rather than a bump, and the
// two concerns the branch mixes — "where along this road does a label go" and
// "which SPACE is that measured in" — become readable, and gateable, apart.
//
// THE LABEL PLANE, in one paragraph. MapLibre lays a line symbol out in a *label
// plane* — the rotated map plane in pixels — and projects the laid-out glyphs to
// the screen (`src/symbol/projection.ts`). X-GIS has always walked the SCREEN-
// projected polyline, which is uniform in the wrong space: on a road running away
// from a pitched camera the glyph spacing (and the whole label chain's cadence) is
// even in screen px, where MapLibre's is even on the ground. The fix reuses what
// the projection loop already produces: project each RETAINED sample a second time
// through the pitch-0 matrix and you have the same polyline in the label plane,
// sharing sample indices with the live run BY CONSTRUCTION. The walk then measures
// in the plane and every glyph is mapped back to the screen by that index
// correspondence — `lerp(live[i], live[i+1], t)`, exact at every sample, no
// inverse and no third projection (design §3.4).
//
// WHAT MUST MOVE TOGETHER, and it is the thing an implementation gets wrong. Once
// the walk is in the plane, EVERY along-run quantity must be: the run length, the
// per-stop cadence, and — the one that hides — the world-lattice phase. `#1358`'s
// world-anchored placement measures `worldPhasePx` with `mercOffsetToScreenOffset`
// over the projected run; measuring it on the LIVE run while walking the PLANE
// leaves the chain anchored in a space the walk does not use, and the measured
// cadence of that work silently regresses under pitch while every label still
// lands on a road (design Q7 — "the first thing a fail-before test should sever").
// `measureRunCadence` below is the single place that choice is made.

import type { LabelDef } from '@xgis/compiler'
import { EARTH } from '@xgis/shared'
import { mercatorYToLat } from '@xgis/geo'
import type { ProjectGroundMerc } from '../../camera/pitch0-unproject'
import type { GroundBasisFor } from './dispatch-point-labels'
import { lineLabelCopyKey, lineLabelDedupeKey } from './line-label-dedupe'
import { latticeMissesRun, type LineLabelDropCounts } from './line-label-drop-stats'
import {
  lineLabelFirstStopPx,
  mercOffsetToScreenOffset,
  sampleAlongPolyline,
} from './place-labels-along-line'

/** Project a RETAINED run's mercator samples through the pitch-0 matrix, giving
 *  the label-plane twin of the live screen run.
 *
 *  Walks the samples the live loop kept — not the source polyline — so index `i`
 *  names the same ground point in both arrays with nothing to keep in step. It is
 *  ALL-OR-NOTHING: one sample without a pitch-0 image (the point is behind the
 *  unpitched camera) and the run keeps its live walk, because a plane polyline
 *  with a hole in it would silently re-index every glyph after the hole.
 *
 *  `worldCopy` is the copy INDEX the live run was projected in — the plane must be
 *  the pitch-0 image of the SAME copy, or the two polylines describe roads 360°
 *  apart. Returns false when the run is unusable. */
export function projectRunToLabelPlane(
  mercX: Float64Array,
  mercY: Float64Array,
  pn: number,
  worldCopy: number,
  project: ProjectGroundMerc,
  outX: Float32Array,
  outY: Float32Array,
): boolean {
  for (let i = 0; i < pn; i++) {
    const q = project(mercX[i]!, mercY[i]!, worldCopy)
    // The projector returns a REUSED tuple: read both slots before the next call.
    if (q === null) return false
    outX[i] = q[0]
    outY[i] = q[1]
  }
  return true
}

/** The two polylines a curved run is walked on. `liveX/liveY` present ⇒
 *  `polyX/polyY` is the label plane; absent ⇒ they ARE the live screen run and
 *  every consumer below reduces to its pre-INC-4 form. */
export interface CurvedRunPolylines {
  polyX: Float32Array
  polyY: Float32Array
  liveX?: Float32Array
  liveY?: Float32Array
}

/** The two along-run quantities the label chain's cadence is built from, measured
 *  on ONE polyline — which is the whole of design Q7.
 *
 *  `total` bounds the walk and `worldPhasePx` anchors it: MapLibre starts the
 *  chain at `tileEntry + k · spacing` measured on the TILE-CLIPPED line, so the
 *  cadence is a property of the world rather than of where the run happens to
 *  start on screen (#1358 / its INC-1+INC-2). Both must be measured in the space
 *  the glyph walk runs in. Taking the phase on the LIVE run while walking the
 *  PLANE is the failure this function exists to make impossible: it leaves every
 *  label on a road — nothing looks broken — while the measured cadence of the
 *  world-anchored work is silently gone under pitch.
 *
 *  Pass the WALK polyline. `mercArc[i]` is the sample's mercator arc length from
 *  polyline vertex 0, and `tileEntryM` the arc length at which the run crosses
 *  into its own tile; the phase may legitimately be NEGATIVE (MVT geometry carries
 *  a buffer, so the crossing usually sits behind the run start). */
export function measureRunCadence(
  walkX: Float32Array,
  walkY: Float32Array,
  mercArc: Float64Array,
  pn: number,
  tileEntryM: number,
): { total: number; worldPhasePx: number } {
  let total = 0
  for (let i = 0; i < pn - 1; i++) {
    const dx = walkX[i + 1]! - walkX[i]!
    const dy = walkY[i + 1]! - walkY[i]!
    total += Math.sqrt(dx * dx + dy * dy)
  }
  return { total, worldPhasePx: mercOffsetToScreenOffset(walkX, walkY, mercArc, pn, tileEntryM) }
}

/** What identifies one projected run for cross-tile dedupe and for collision —
 *  the three keys every stop on it shares. */
export interface CurvedRunIdentity {
  pairedWithIcon: boolean
  copyTextKey: string
  lineId: string | undefined
  lineCollisionId: string | undefined
}

/** Derive that identity. Moved here with the emit it feeds (#2012 INC-4): it is
 *  curved-branch-only — the viewport branch's `emitLabelAlongSegment` carries no
 *  lineId — so on a `text-rotation-alignment: viewport` layer it was dead work
 *  done per polyline, per world copy.
 *
 *  #605 — a route-number SHIELD (text+icon line symbol, OFM highway-shield-*:
 *  text-field = `["to-string",["get","ref"]]`) is identified by its REF ("82"),
 *  not the road `name`. A national route overlays many differently-named OSM road
 *  segments — some carry a street `name`, some only `ref` — so a `name`-preferring
 *  key diverges per segment and the same "82" shield stamps once PER distinct name
 *  across the tiles a route fills at high zoom (~6× at z19 vs MapLibre ~1×). Keying
 *  shields on the RESOLVED drawn text (the ref) is stable across every segment of
 *  one route, so the along-walk dedupe collapses the route to one shield —
 *  MapLibre's per-route cadence. The ref is monolingual, so the bilingual-
 *  divergence concern that motivates the `name` path does not apply to shields.
 *  For a plain road-NAME label `resolveText()` DOES vary across segments when one
 *  carries `name:nonlatin` and the next does not, so the most stable name field
 *  wins there instead — see `lineLabelDedupeKey`.
 *
 *  `lineId` is the TILE-STABLE identity the collision pass caps same-route repeats
 *  on (`minLineSpacingPx`): the route identity, never the tile, qualified by layer
 *  with a NUL — a char no ref/name contains — so two layers' identical refs stay
 *  independent lines. Empty key (an icon-only symbol renders no text and the label
 *  no-ops downstream) ⇒ undefined: not subject to same-line spacing, exactly like a
 *  point label. `mintCollisionId` is passed in rather than imported because the
 *  minting authority lives in label-pass.ts. */
export function curvedRunIdentity(
  featDef: LabelDef,
  props: Record<string, unknown>,
  zoom: number,
  worldCopy: number,
  layerName: string | undefined,
  mintCollisionId: (lineId: string) => string,
): CurvedRunIdentity {
  // Iter 112 paired-symbol collision for CURVED shields: a tangent-rotated line
  // label with a paired icon-image (OFM highway-shield-* / road_shield_us at
  // z>=11) must place/drop with its badge, so each emitted stop gets a fresh
  // `${layer}:seq${n}` shared by the label AND its icon.
  const pairedWithIcon =
    featDef.iconImage !== undefined && featDef.iconImage !== null && featDef.iconImage !== ''
  const copyTextKey = lineLabelCopyKey(
    lineLabelDedupeKey(pairedWithIcon, featDef.text, props, zoom),
    worldCopy,
  )
  const lineId = copyTextKey !== '' ? `${layerName ?? ''}\u0000${copyTextKey}` : undefined
  return {
    pairedWithIcon,
    copyTextKey,
    lineId,
    // #728 — stable collision identity: layer precedence + the tile-stable route
    // identity, fed to the greedy pass as its tie-break so the survivor among
    // cross-tile duplicates is deterministic (no pan-swap).
    lineCollisionId: lineId !== undefined ? mintCollisionId(lineId) : undefined,
  }
}

/** Everything the per-stop emit needs from the frame + layer scope. Bundled
 *  rather than passed positionally, for the reason `EmitLabelAlongSegmentDeps`
 *  gives: a positional list this long is a swap waiting to happen. */
export interface CurvedLineLabelDeps {
  /** `TextStage.addCurvedLineLabel`, bound. */
  addCurvedLineLabel: (
    value: LabelDef['text'],
    props: Record<string, unknown>,
    polylineX: Float32Array,
    polylineY: Float32Array,
    centerOffsetPx: number,
    def: LabelDef,
    fontKey: string | undefined,
    layerName: string | undefined,
    pairKey: string | undefined,
    lineId: string | undefined,
    anchorDistancePx: number | undefined,
    collisionId: string | undefined,
    ground?: {
      liveX: Float32Array
      liveY: Float32Array
      basis: ArrayLike<number> | undefined
    },
  ) => void
  /** `label-pass`'s icon dispatcher. Slot order mirrors it exactly. */
  dispatchIcon: (
    def: LabelDef,
    ax: number,
    ay: number,
    lineTangentDeg: number,
    pairKey: string | undefined,
    collide: boolean,
    props: Record<string, unknown> | undefined,
    perspScale: number | undefined,
    collisionId: string | undefined,
  ) => void
  bumpDrop: (k: keyof LineLabelDropCounts) => void
  /** #1314 viewport edge inset, evaluated on the LIVE anchor. */
  anchorInView: (sx: number, sy: number) => boolean
  isTooCloseToSameText: (resolvedText: string, sx: number, sy: number) => boolean
  recordTextPosition: (resolvedText: string, sx: number, sy: number) => void
  /** #603 position-bucket dedupe for text-less line icons. */
  isLineIconDuplicate: (sx: number, sy: number) => boolean
  /** Mints `${layer}:seq${n}` — a FUNCTION because the sequence is shared with
   *  the viewport branch's emitter and copying its value forks the counter. */
  nextPairKey: () => string
  layerName: string | undefined
}

/** The per-run, per-feature context the stops share. */
export interface CurvedLineLabelRun extends CurvedRunPolylines {
  /** Sample count — the length of every parallel array here. */
  pn: number
  /** Mercator metres per retained sample. Present with `liveX/liveY`: this is
   *  where a label's OWN ground point comes from, and the basis is derived there
   *  rather than at the screen anchor (the predecessor's far-field error). */
  mercX?: Float64Array
  mercY?: Float64Array
  /** `mercArc[i]` is the sample's mercator arc length from polyline vertex 0, and
   *  `tileEntryM` the arc length at which the run crosses into its own tile. The
   *  cadence is derived from these HERE rather than handed in, so the phase and
   *  the run length cannot be measured in a different space from the walk — see
   *  `measureRunCadence` and design Q7. */
  mercArc: Float64Array
  tileEntryM: number
  spacingPx: number
  featDef: LabelDef
  props: Record<string, unknown>
  copyTextKey: string
  lineId: string | undefined
  lineCollisionId: string | undefined
  isIconOnly: boolean
  pairedWithIcon: boolean
  /** The ground-basis producer, absent when this layer/frame billboards. */
  groundBasisFor?: GroundBasisFor
}

/** `[x, y, tangentDeg, segIdx, segT]` — reused across stops. */
const _sampleOut: [number, number, number, number, number] = [0, 0, 0, 0, 0]
/** Reused `ground` holder — `addCurvedLineLabel` copies the fields out. */
const _groundArgs: {
  liveX: Float32Array
  liveY: Float32Array
  basis: ArrayLike<number> | undefined
} = { liveX: new Float32Array(0), liveY: new Float32Array(0), basis: undefined }

/** Walk one projected run and emit the curved labels the world lattice puts on it
 *  (or the single midpoint label a short run gets), with the paired icon and the
 *  dedupe bookkeeping each stop owes.
 *
 *  ONE emission body for both cadences: they differed only in the offset, and the
 *  paired-symbol sequence, the icon dispatch and the dedupe bookkeeping have to
 *  stay in lockstep between them — two copies is how that drifts. */
export function emitCurvedLineLabels(run: CurvedLineLabelRun, deps: CurvedLineLabelDeps): void {
  const ground = run.liveX !== undefined && run.liveY !== undefined
  // Design Q7, made unrepresentable rather than merely gated: the ONLY polyline in
  // scope for the cadence is the one the stops are walked on, because it is read
  // off the same `run` field the walk uses.
  const { total, worldPhasePx } = measureRunCadence(
    run.polyX,
    run.polyY,
    run.mercArc,
    run.pn,
    run.tileEntryM,
  )
  const emitStop = (stop: number): void => {
    // The stop is an offset along the WALK polyline; the anchor it resolves to is
    // the LIVE screen point at the same (segment, fraction) — the index
    // correspondence. Every downstream test (edge inset, dedupe, the icon's own
    // rotation) is a SCREEN question and therefore asks it of the live point.
    if (!sampleAlongPolyline(run.polyX, run.polyY, run.pn, stop, _sampleOut, run.liveX, run.liveY))
      return deps.bumpDrop('offRun')
    const sx = _sampleOut[0],
      sy = _sampleOut[1]
    const tang = _sampleOut[2]
    if (!deps.anchorInView(sx, sy)) return deps.bumpDrop('edgeInset')
    if (deps.isTooCloseToSameText(run.copyTextKey, sx, sy)) return deps.bumpDrop('sameTextNearby')
    if (run.isIconOnly && run.pairedWithIcon && deps.isLineIconDuplicate(sx, sy))
      return deps.bumpDrop('iconDuplicate')
    const pairKey = run.pairedWithIcon ? deps.nextPairKey() : undefined
    let groundArgs: typeof _groundArgs | undefined
    if (ground) {
      // The label's OWN ground point, read off the run's mercator samples at the
      // correspondence the anchor resolved to — NOT the pitch-0 unprojection of a
      // screen anchor, which is a different ground point everywhere but the screen
      // centre (design §1.4(a)). One basis per LABEL, derived at its centre: the
      // basis is a first derivative of a smooth projection and varies little over
      // a label's span, so a per-glyph basis would be ~6 projections × glyphs ×
      // labels to buy back a bounded residual (design §3.4(6) / Q3).
      const i = _sampleOut[3]
      const t = _sampleOut[4]
      const mx = run.mercX!
      const my = run.mercY!
      const gx = mx[i]! + (mx[i + 1]! - mx[i]!) * t
      const gy = my[i]! + (my[i + 1]! - my[i]!) * t
      // World copies are the same ground point seen twice, so the UNSHIFTED merc
      // sample is the right lon/lat for every copy — the same argument
      // `dispatchPointLabel` makes for its anchor.
      const lon = gx / ((Math.PI / 180) * EARTH.sphereR)
      const lat = mercatorYToLat(gy)
      _groundArgs.liveX = run.liveX!
      _groundArgs.liveY = run.liveY!
      _groundArgs.basis = run.groundBasisFor?.(run.featDef, lon, lat)
      groundArgs = _groundArgs
    }
    deps.addCurvedLineLabel(
      run.featDef.text,
      run.props,
      run.polyX,
      run.polyY,
      stop,
      run.featDef,
      undefined,
      deps.layerName,
      pairKey,
      // #605 — same-route screen-space cap: lineId is the tile-stable route
      // identity; anchorDistancePx is the anchor's along-polyline offset.
      run.lineId,
      stop,
      run.lineCollisionId,
      groundArgs,
    )
    // OFM road shield + similar: icon-along-line approximation. Dispatch the icon
    // at the line label's anchor so highway-shield-* layers (symbol-placement=line
    // at z≥11) render road badges. `tang` carries the LIVE segment direction so
    // icon-rotation-alignment=map (OFM road_oneway arrows) follows the road as it
    // appears on screen. Same pairKey as the label so the badge drops when the road
    // number loses collision.
    deps.dispatchIcon(run.featDef, sx, sy, tang, pairKey, true, run.props, 1, run.lineCollisionId)
    deps.recordTextPosition(run.copyTextKey, sx, sy)
    deps.bumpDrop('emitted')
  }
  if (total < run.spacingPx * 0.5) {
    emitStop(total * 0.5)
    return
  }
  // INC-2 of the world-anchored work — the same world lattice the viewport branch
  // walks: the chain starts at the tile-entry anchor's residue mod the step, not
  // half a step into whatever the viewport happens to show.
  let nextStop = lineLabelFirstStopPx(worldPhasePx, run.spacingPx)
  if (latticeMissesRun(nextStop, run.spacingPx, total)) deps.bumpDrop('noLatticeStop')
  while (nextStop <= total) {
    emitStop(nextStop)
    nextStop += run.spacingPx
  }
}
