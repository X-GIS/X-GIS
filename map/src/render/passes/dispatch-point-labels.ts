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
// screen-space images of the anchor's ground axes by composing the live
// projector with the SAME projection's pitch-0 inverse, which is what makes
// "unpitched labels do not move" a property of the code rather than of a test
// (see text/ground-basis.ts). Everything downstream — the collision AABB, the
// quad corners, the perspectiveScale exclusion — has been in place since #1462;
// this is the producer that was missing.

import type { LabelDef } from '@xgis/compiler'
import { resolvePitchAlignment } from '@xgis/compiler'
import type { Pitch0Unprojector, Pitch0View } from '../../camera/pitch0-unproject'
import { groundBasisAt, isIdentityBasis, type GroundBasis } from '../../text/ground-basis'

/** Screen-space projector for a lon/lat, or null when the point is not on screen
 *  / the projection has no image for it. */
export type ProjectLonLat = (lon: number, lat: number) => [number, number] | null

/** Derives a label's ground basis, or `undefined` when it must stay a billboard.
 *  `undefined` is the signal the whole chain is built around: the field is then
 *  omitted, the renderer takes its skip path, and the vertices are bit-identical
 *  to what shipped before IV3 (#1442 proved that). */
export type GroundBasisFor = (
  def: LabelDef,
  anchorScreenX: number,
  anchorScreenY: number,
  dpr: number,
) => GroundBasis | undefined

/** The linearization radius handed to `groundBasisAt`, in device px.
 *
 *  It should be the label's own extent — its quad half-diagonal (#1424's stated
 *  limit: a basis is exact only over the range it spans). The dispatch site
 *  cannot know that: the quad is sized in text-stage from `sizePx`, long after
 *  `addLabel` returns, and all the caller holds is the anchor. So this
 *  approximates it from the font size, which is the term `sizePx` is built from
 *  and is within a small factor of the half-diagonal for any real label.
 *
 *  The approximation is safe rather than merely convenient, and the reason is
 *  worth stating: the basis is a first derivative of a smooth projection, so
 *  over the tens of px a glyph quad spans it barely varies — the error from
 *  probing at 12 px instead of 40 px is far below the sub-pixel scale at which
 *  a wrong basis would be visible. What is NOT safe is a probe of zero or a
 *  non-finite one, which `groundBasisAt` rejects outright rather than
 *  propagating as NaN into every vertex.
 */
function probePxFor(def: LabelDef, dpr: number): number {
  const size = def.size
  return Number.isFinite(size) && size! > 0 ? size! * dpr : 16 * dpr
}

/** Build the per-frame ground-basis producer.
 *
 *  `pitch0` must outlive the frame — it owns a matrix/inverse pair and a cache
 *  whose entire point is that a pure tilt is a HIT, so one per map (a WeakMap on
 *  the pass, matching how the pass already holds per-host state), never one per
 *  frame.
 *
 *  Returns `undefined` — the billboard path — for every label the spec does not
 *  ground-align, and also whenever the basis cannot be derived at all: the
 *  azimuthal discs and the globe have no pitch-0 lon/lat (`unprojectToLonLat`
 *  returns null there), and an anchor on the horizon degenerates. None of those
 *  are patched with a per-projection fallback; see the two-authorities note at
 *  the head of text/ground-basis.ts. */
export function makeGroundBasisFor(
  view: Pitch0View & { readonly pitch: number },
  canvasW: number,
  canvasH: number,
  projectLonLat: ProjectLonLat,
  pitch0: Pitch0Unprojector,
): GroundBasisFor {
  return (def, anchorScreenX, anchorScreenY, dpr) => {
    // AN UNPITCHED CAMERA SHORT-CIRCUITS, and it does so on `pitch` rather than
    // on the computed basis. Mathematically the two are the same test — at pitch
    // 0 the projector IS the inverse of the pitch-0 unprojector, so the basis is
    // exactly [1,0,0,1]. Numerically they are not: the round trip runs through an
    // f32 MVP and an f32 invert, and the identity comes back off by up to
    // **1.995e-6** (measured across zoom 2–18, latitude 0–70, bearings 0/37/90/180
    // and four anchor positions). That is ~2000× `isIdentityBasis`'s 1e-9 default,
    // so the computed test would say "not identity", a basis would be supplied,
    // the renderer would walk its transform path, and the no-regression rung —
    // unpitched frames bit-identical to before IV3 (#1442) — would fail on pure
    // float noise.
    //
    // Widening the epsilon to straddle that floor is the tripwire CLAUDE.md §12
    // warns about: it would be a number chosen to make a test pass, and it would
    // silently swallow a real small tilt too. Reading the camera instead is exact
    // and needs no tolerance. `Camera.pitch` is the accessor-gated one, so a
    // `pitchLocked` projection (the azimuthal discs) reads 0 and lands here — which
    // is right, since those have no pitch-0 inverse to compose against anyway.
    if (!(view.pitch > 0)) return undefined
    // The spec chain, from the SHARED authority the converter's runtime-gap
    // warning uses (compiler/src/ir/label-alignment.ts) — so a label the
    // converter reported as ground-aligned is exactly the set handled here.
    if (resolvePitchAlignment(def.placement, def.rotationAlignment, def.pitchAlignment) !== 'map')
      return undefined
    const basis = groundBasisAt(
      anchorScreenX,
      anchorScreenY,
      probePxFor(def, dpr),
      (sx, sy) => pitch0.unprojectToLonLat(view, sx, sy, canvasW, canvasH, dpr),
      projectLonLat,
    )
    if (basis === null) return undefined
    // An unpitched camera yields exactly the identity by construction. Supplying
    // it would be a no-op that still walks the renderer's transform path; omit
    // instead, so an unpitched frame stays provably bit-identical rather than
    // merely arithmetically equal.
    return isIdentityBasis(basis) ? undefined : basis
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
  dpr: number
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
    const basis = deps.groundBasisFor(featDef, projected[0], projected[1], deps.dpr)
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
      ps,
      basis,
    )
    deps.dispatchIcon(featDef, projected[0], projected[1], 0, pairKey, false, undefined, ps)
  }
}
