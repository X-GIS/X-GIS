// ═══ #777 IV3 — point-label dispatch, and the ground basis it may carry ═══
//
// Extracted from `label-pass.ts` (which sat exactly at its LOC ceiling) so the
// ground-basis production has a home that is not a god-file, and so the two
// concerns the dispatch loop mixes — "where does this feature's label go" and
// "is that label a billboard or does it lie in the ground plane" — are readable
// apart.
//
// THE GROUND BASIS, in one paragraph. A label whose resolved
// `text-pitch-alignment` is `map` lies IN the ground plane: it foreshortens and
// tilts with the camera instead of standing up. `groundBasisAt` derives the
// screen-space images of the label's ground axes as the ratio of the live and
// pitch-0 forward Jacobians of the SAME projection, taken at the label's own
// lon/lat, which is what makes "unpitched labels do not move" a property of the
// code rather than of a test (see text/ground-basis.ts). Everything downstream —
// the collision AABB, the quad corners, the perspectiveScale exclusion — has been
// in place since #1462; this is the producer.

import type { LabelDef } from '@xgis/compiler'
import { resolvePitchAlignment } from '@xgis/compiler'
import { makeGroundProjector, type FlatGroundView } from '../../camera/pitch0-unproject'
import {
  groundBasisAt,
  groundPerspectiveScale,
  IDENTITY_BASIS,
  isIdentityBasis,
  type GroundBasis,
} from '../../text/ground-basis'

/** Everything a label needs in order to lie in the ground plane, derived at its
 *  own ground point in one go.
 *
 *  The two travel together because they are two halves of one answer and they are
 *  read off the SAME projection: `basis` is where the quad lies, `sizeScale` how
 *  big it is there (MapLibre's `perspective_ratio`, map branch — #2012 INC-5,
 *  design §3.3). Splitting them across two producers would put the size on a
 *  different ground point from the tilt at the one anchor where it matters most,
 *  the far field.
 *
 *  REUSED HOLDER — read both fields out immediately, exactly as with the
 *  projectors' scratch tuples (the aliasing that made #1471 + #1492 inert on main
 *  is the same shape one level up). */
export interface GroundAlignment {
  basis: GroundBasis
  /** Multiplies the label's `sizePx`. 1 = no correction. */
  sizeScale: number
}

/** Derives a label's ground alignment from the label's own ground point, or
 *  `undefined` when it must stay a billboard. `undefined` is the signal the whole
 *  chain is built around: the fields are then omitted, the renderer takes its skip
 *  path, and the vertices are bit-identical to what shipped before IV3 (#1442
 *  proved that).
 *
 *  Takes lon/lat rather than the screen anchor: the basis is a property of the
 *  ground point, and a label's world copies (`projectLonLatCopies` fans an anchor
 *  out across ±360°) are the same ground point seen twice, so they share one.
 *  `sizeScale` inherits that treatment — see where it is computed. */
export type GroundBasisFor = (
  def: LabelDef,
  lon: number,
  lat: number,
) => GroundAlignment | undefined

/** Build the per-frame ground-basis producer.
 *
 *  `liveMvp` must be the SAME matrix the label anchors were placed through
 *  (`getViewForProjection(...).matrix`), `pitch0Mvp` its pitch-forced-to-0 twin
 *  (`Pitch0Unprojector.matrix`), and `flat` the SAME projection constants
 *  `makeLabelProjectors` was handed — pairing the basis with any other frame
 *  would put the quad in a different one from its own anchor.
 *
 *  Returns `undefined` — the billboard path — for every label the spec does not
 *  ground-align, for the globe (`flat` is absent there: projType 7 renders through
 *  the ECEF projector and is deferred with its reason in §3.2 of the design), and
 *  whenever the basis degenerates. None of those is patched with a per-projection
 *  fallback; see the two-authorities note at the head of text/ground-basis.ts. */
export function makeGroundBasisFor(
  view: { readonly pitch: number },
  liveMvp: Float32Array,
  pitch0Mvp: Float32Array,
  canvasW: number,
  canvasH: number,
  flat: FlatGroundView | undefined,
): GroundBasisFor {
  // The globe has no map plane to lie in; withhold before building anything.
  if (flat === undefined) return () => undefined
  const projectLive = makeGroundProjector(liveMvp, canvasW, canvasH, flat)
  const projectPitch0 = makeGroundProjector(pitch0Mvp, canvasW, canvasH, flat)
  // #2012 INC-5 — clip-w of the camera-centre anchor. The live label matrix is
  // camera-relative (RTC), so the centre sits at the origin and its divisor IS
  // `mvp[15]`; the same identity #1081 uses in `makeLabelProjectors`.
  const wCenter = liveMvp[15]!
  const _align: GroundAlignment = { basis: IDENTITY_BASIS, sizeScale: 1 }
  return (def, lon, lat) => {
    // AN UNPITCHED CAMERA SHORT-CIRCUITS, and it does so on `pitch` rather than on
    // the computed basis. Under the ratio construction the two really are the same
    // test — at pitch 0 the pitch-0 matrix IS the live matrix element for element
    // (pitch0-unproject.test.ts pins that), so `projectLive` and `projectPitch0`
    // are the same function on the same floats and the basis is EXACTLY [1,0,0,1],
    // which `isIdentityBasis` then withholds below. The predecessor could not say
    // that: it composed an f32 invert, and the identity came back off by up to
    // 1.995e-6 — ~2000× the 1e-9 epsilon — so reading the camera was the only
    // exact test available. Keeping it is now about COST (six projections per
    // label, on every unpitched frame, to reach a foregone conclusion) and about
    // keeping the no-regression rung — unpitched frames bit-identical to before
    // IV3 (#1442) — independent of any float argument at all.
    //
    // Widening `isIdentityBasis`'s epsilon instead of reading the camera stays the
    // tripwire CLAUDE.md §12 warns about: it would be a number chosen to make a
    // test pass, and it would silently swallow a real small tilt too.
    if (!(view.pitch > 0)) return undefined
    // The spec chain, from the SHARED authority the converter's runtime-gap
    // warning uses (compiler/src/ir/label-alignment.ts) — so a label the
    // converter reported as ground-aligned is exactly the set handled here.
    if (resolvePitchAlignment(def.placement, def.rotationAlignment, def.pitchAlignment) !== 'map')
      return undefined
    const basis = groundBasisAt(lon, lat, projectLive, projectPitch0)
    if (basis === null) return undefined
    // An unpitched camera yields exactly the identity by construction. Supplying
    // it would be a no-op that still walks the renderer's transform path; omit
    // instead, so an unpitched frame stays provably bit-identical rather than
    // merely arithmetically equal.
    if (isIdentityBasis(basis)) return undefined
    // #2012 INC-5 — the pitched SIZE correction, at the same ground point and off
    // the same cull-free projection. A seventh call rather than a reach into
    // `groundBasisAt`'s probes: those land at (lon+δ) and (lat+δ), and reading the
    // divisor from whichever ran last would silently make the anchor's distance a
    // property of the probe ORDER. δ is 1e-8°, so the difference is beneath float
    // noise — which is exactly why an order-dependent read would never be caught.
    //
    // READ THE SLOT OUT IMMEDIATELY: this is a reused scratch tuple.
    const here = projectLive(lon, lat)
    if (here === null) return undefined
    const cw = here[2]
    _align.basis = basis
    // ONE value per ground point, shared by that point's world copies — the same
    // treatment the basis gets two lines up, and deliberately so: a copy 360° away
    // genuinely sits at a different camera distance, but changing that for the size
    // while the basis it must agree with stays per-ground-point would split the two
    // halves of one answer across two ground points. Copies are only visible at the
    // low zooms where the pitched distance spread is smallest. Recorded rather than
    // silently approximated; lifting it is a change to the BASIS first.
    _align.sizeScale = groundPerspectiveScale(cw / wCenter)
    return _align
  }
}

/** Everything the point-label loop needs from `label-pass`'s frame scope. */
export interface PointLabelDeps {
  applyFeatureExprs: (props: Record<string, unknown>) => LabelDef
  projectLonLatCopies: (lon: number, lat: number) => Array<[number, number, number]>
  addLabel: (
    value: LabelDef['text'],
    props: Record<string, unknown>,
    x: number,
    y: number,
    def: LabelDef,
    fontKey: string | undefined,
    layerName: string | undefined,
    pairKey: string | undefined,
    collisionId: string | undefined,
    perspectiveScale: number | undefined,
    groundBasis: ArrayLike<number> | undefined,
  ) => void
  /** `label-pass`'s icon dispatcher. Slot order mirrors it exactly:
   *  (def, ax, ay, lineTangentDeg, pairKey, collide, props, perspScale). */
  dispatchIcon: (
    def: LabelDef,
    ax: number,
    ay: number,
    lineTangentDeg: number,
    pairKey: string | undefined,
    collide: boolean,
    props: Record<string, unknown> | undefined,
    perspScale: number | undefined,
  ) => void
  layerName: string
  /** Mints the paired-symbol collision key; the sequence lives on the caller so
   *  it stays per-frame-per-layer exactly as it did inline. */
  nextPairKey: () => string
  groundBasisFor: GroundBasisFor
}

/** Dispatch one point feature's label (and its paired icon) at every visible
 *  world copy. Mechanically the block that lived at `label-pass.ts:1171`, plus
 *  the ground-basis argument.
 *
 *  The `def` passed to `addLabel` is deliberately the FULL LabelDef with no
 *  `fontKey` override: passing `def.font?.[0]` there short-circuits
 *  `TextStage.composeFontKey`, and every Mapbox label then renders in Regular
 *  weight and loses its Hangul / Han fallback chain. The comment rode every call
 *  site inline so the override could not quietly come back; it rides this one now.
 */
export function dispatchPointLabel(
  geometry: unknown,
  props: Record<string, unknown>,
  anchorLon: number,
  anchorLat: number,
  deps: PointLabelDeps,
): void {
  void geometry
  const featDef = deps.applyFeatureExprs(props)
  for (const projected of deps.projectLonLatCopies(anchorLon, anchorLat)) {
    // iter 119: point-label paired-symbol collision. OFM Positron
    // label_city/town/village pair the place name with circle_11_black and rely
    // on icon-optional=false to drop the icon when the text drops.
    const pairedWithIcon =
      featDef.iconImage !== undefined && featDef.iconImage !== null && featDef.iconImage !== ''
    const pairKey = pairedWithIcon ? deps.nextPairKey() : undefined
    // #1081 — this copy's perspective distance-attenuation factor
    // (projectLonLatCopies tuple slot 3); shared by the label and its icon.
    const ps = projected[2]
    // Derived at the label's OWN ground point, so every world copy of this
    // feature gets the same basis — they are one ground point seen twice.
    const align = deps.groundBasisFor(featDef, anchorLon, anchorLat)
    deps.addLabel(
      featDef.text,
      props,
      projected[0],
      projected[1],
      featDef,
      undefined,
      deps.layerName,
      pairKey,
      undefined,
      // #2012 INC-5 — ONE perspective size multiplier per label, in the branch its
      // own alignment selects, which is how MapLibre's shader spends its single
      // `perspective_ratio` (`u_pitch_with_map`). A ground-aligned label takes the
      // map branch and GROWS with distance; a billboard keeps #1081's shrink-only
      // viewport branch. The paired ICON always keeps the viewport one —
      // `icon-pitch-alignment` is ADR-0012 D3 and is not wired here.
      align !== undefined ? align.sizeScale : ps,
      align?.basis,
    )
    deps.dispatchIcon(featDef, projected[0], projected[1], 0, pairKey, false, undefined, ps)
  }
}
