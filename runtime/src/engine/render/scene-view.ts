// ═══ X-GIS RenderLoop — per-frame SceneView ═══
//
// Read-only view over the scene state the render passes consume. Built
// once per frame from the bucket scheduler's classification, right after
// the MSAA/RT block has run (so `ctx.rt` textures are ensured). Bundling
// these derived values into one struct lets the pass-extraction phases
// hand each pass a single `scene` arg instead of threading ~8 separate
// locals out of `RenderLoop.render`.
//
// This is a pure relocation of the bucket-scheduler block that used to
// live inline in render() — every field is computed from the SAME
// expression at the SAME point (just after the per-renderer beginFrame
// calls), so behaviour is byte-identical. SceneView carries DATA only;
// side effects (e.g. `lineRenderer.ensureOffscreen`) stay in render().

import type { ClassifiedShow, OpaqueGroup } from './bucket-scheduler'
import type { FrameContext } from './frame-context'
import type { RenderLoopHost } from '../render-loop'

/** Which pass owns the MSAA `resolveTarget` — precisely the last pass
 *  that writes the colour target. Priority: dedicated points > last
 *  translucent composite > last opaque sub-pass. */
export type ResolveOwner = 'points' | 'composite' | 'opaque'

/** Per-frame scene classification the render passes read from. */
export interface SceneView {
  /** Opaque-bucket shows (fills + opaque strokes + fill half of
   *  translucent-stroke layers). */
  readonly opaque: ClassifiedShow[]
  /** Translucent-stroke shows, rendered offscreen + composited. */
  readonly translucent: ClassifiedShow[]
  /** Order-independent-transparency shows (translucent extruded fills). */
  readonly oit: ClassifiedShow[]
  /** Opaque shows grouped into same-source sub-passes. */
  readonly opaqueGroups: OpaqueGroup[]
  /** `translucent.length > 0 && lineRenderer !== null`. */
  readonly hasTranslucent: boolean
  /** `oit.length > 0` AND both OIT textures are present. */
  readonly hasOit: boolean
  /** PointRenderer has direct-layer points to draw. */
  readonly hasPoints: boolean
  /** Which pass claims the MSAA resolveTarget this frame. */
  readonly resolveOwner: ResolveOwner
}

/** Members of the owning map that SceneView derivation reads. */
type SceneHost = Pick<RenderLoopHost,
  'classifyVectorTileShows' | 'groupOpaqueBySource' | 'lineRenderer' | 'pointRenderer'>

/** Build the per-frame SceneView from the bucket scheduler. Mirrors the
 *  inline block formerly at render()'s bucket-scheduler section. */
export function buildSceneView(host: SceneHost, ctx: FrameContext): SceneView {
  const { opaque, translucent, oit } = host.classifyVectorTileShows()
  const opaqueGroups = host.groupOpaqueBySource(opaque)
  const hasTranslucent = translucent.length > 0 && host.lineRenderer !== null
  const hasOit = oit.length > 0 && ctx.rt.oitAccumTexture !== null && ctx.rt.oitRevealageTexture !== null
  const hasPoints = host.pointRenderer?.hasLayers() ?? false
  // Which pass owns the MSAA resolveTarget? The last pass that writes the
  // color target. Priority: dedicated points > last composite > last opaque.
  const resolveOwner: ResolveOwner = hasPoints
    ? 'points'
    : hasTranslucent
      ? 'composite'
      : 'opaque'
  return { opaque, translucent, oit, opaqueGroups, hasTranslucent, hasOit, hasPoints, resolveOwner }
}
