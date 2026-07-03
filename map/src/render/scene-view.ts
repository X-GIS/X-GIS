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
import type { FrameContext } from '@xgis/engine'
import type { RenderLoopHost } from '../render-loop'

/** Which pass owns the MSAA `resolveTarget` — precisely the last pass
 *  that writes the colour target. Priority: dedicated points > last
 *  translucent composite > last opaque sub-pass. */
type ResolveOwner = 'points' | 'composite' | 'opaque'

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
  /** HeatmapRenderer has direct-layer heatmap layers to draw. Gates the
   *  heatmap pass + its density-target allocation — false (the default) keeps
   *  the frame byte-identical (no target alloc, no pass). */
  readonly hasHeatmap: boolean
  /** GraphicsManager has ≥1 retained host-drawing batch (#797 P1). Gates the
   *  graphics pass — false (the default) means the pass never runs, so a map
   *  with no host batches is byte-identical. */
  readonly hasGraphics: boolean
  /** Which pass claims the MSAA resolveTarget this frame. */
  readonly resolveOwner: ResolveOwner
}

/** Members of the owning map that SceneView derivation reads. */
type SceneHost = Pick<
  RenderLoopHost,
  | 'classifyVectorTileShows'
  | 'groupOpaqueBySource'
  | 'lineRenderer'
  | 'pointRenderer'
  | 'heatmapRenderer'
  | 'graphics'
>

/** Build the per-frame SceneView from the bucket scheduler. Mirrors the
 *  inline block formerly at render()'s bucket-scheduler section. */
// `_ctx` is retained for signature stability (callers pass the FrameContext)
// but is no longer read: hasOit went content-based, which was its only use.
export function buildSceneView(host: SceneHost, _ctx: FrameContext): SceneView {
  const { opaque, translucent, oit } = host.classifyVectorTileShows()
  const opaqueGroups = host.groupOpaqueBySource(opaque)
  const hasTranslucent = translucent.length > 0 && host.lineRenderer !== null
  // Content-based: the OIT targets are now lazily allocated by the OIT pass
  // (ctx.rt.ensureOit) when this flag is set, so it can no longer depend on
  // the textures already existing — that would always be false on the lazy
  // path and the OIT pass would never run.
  const hasOit = oit.length > 0
  const hasPoints = host.pointRenderer?.hasLayers() ?? false
  const hasHeatmap = host.heatmapRenderer?.hasLayers() ?? false
  const hasGraphics = host.graphics?.hasRetainedBatches() ?? false
  // Which pass owns the MSAA resolveTarget? The last pass that writes the
  // color target. Priority: dedicated points > last composite > last opaque.
  // The heatmap pass composites AFTER labels onto the resolved swapchain, so
  // it does NOT participate in resolveOwner.
  const resolveOwner: ResolveOwner = hasPoints ? 'points' : hasTranslucent ? 'composite' : 'opaque'
  return {
    opaque,
    translucent,
    oit,
    opaqueGroups,
    hasTranslucent,
    hasOit,
    hasPoints,
    hasHeatmap,
    hasGraphics,
    resolveOwner,
  }
}
