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
// side effects stay in render().

import type { ClassifiedShow, OpaqueGroup, ResolveOwner } from './bucket-scheduler'
import { deriveResolveOwner } from './bucket-scheduler'
import type { FrameContext } from './frame-context'
import type { RenderLoopHost } from '../render-loop'

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
  /** HillshadeRenderer has a `raster-dem` source armed (#777). Gates the
   *  hillshade pass — false (the default) means the pass never runs, so a map
   *  with no hillshade layer is byte-identical (no pass). */
  readonly hasHillshade: boolean
  /** GraphicsManager has ≥1 retained host-drawing batch (#797 P1). Gates the
   *  graphics pass — false (the default) means the pass never runs, so a map
   *  with no host batches is byte-identical. */
  readonly hasGraphics: boolean
  /** A resident coverage carries a velocity field (#1333) — S-111 currents, not S-102
   *  bathymetry.
   *
   *  NO LONGER GATES THE FLOW PASS, and no production code reads it today. The pass
   *  used to `shouldRun` on this flag; that skipped the whole execute on the frame the
   *  LAST region evicts — the one frame the arrow declaration must happen, since this
   *  flag IS `hasFlowField()` and turns false exactly then (#1419, #1046 Inc-F2c). The
   *  gate moved INSIDE `flow-pass.ts` where it can sit below the declaration, so the
   *  no-allocation property it was written for still holds: a scalar-coverage or
   *  coverage-less map still allocates no IBFV pair and still renders byte-identically.
   *  Kept as a frame fact rather than deleted — it is correct and cheap — but do not
   *  reintroduce it as a pass gate. */
  readonly hasFlow: boolean
  /** Which pass claims the MSAA resolveTarget this frame. */
  readonly resolveOwner: ResolveOwner
  /** #1429 INC-2 — the adaptive ladder holds the scene target below native
   *  this frame. Gates the scene-upscale seam; false (the ladder at notch
   *  0-2, the twin always) keeps the frame byte-identical: no scene pair
   *  allocated, no seam pass, one colour attachment as before the split. */
  readonly sceneScaled: boolean
}

/** Members of the owning map that SceneView derivation reads. */
type SceneHost = Pick<
  RenderLoopHost,
  | 'classifyVectorTileShows'
  | 'groupOpaqueBySource'
  | 'lineRenderer'
  | 'pointRenderer'
  | 'heatmapRenderer'
  | 'hillshadeRenderer'
  | 'graphics'
  | 'coverageRenderer'
>

/** Build the per-frame SceneView from the bucket scheduler. Mirrors the
 *  inline block formerly at render()'s bucket-scheduler section. */
// `ctx` supplies the two target geometries the sceneScaled flag derives from
// (#1429 INC-2); hasOit stays content-based.
export function buildSceneView(host: SceneHost, ctx: FrameContext): SceneView {
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
  const hasHillshade = host.hillshadeRenderer?.hasSource() ?? false
  const hasGraphics = host.graphics?.hasRetainedBatches() ?? false
  const hasFlow = host.coverageRenderer?.hasFlowField() ?? false
  // Which pass owns the MSAA resolveTarget? deriveResolveOwner is the single
  // priority authority (bucket-scheduler.ts) — the last colour-writing pass
  // in PASS_CHAIN_ORDER. The heatmap pass composites AFTER labels onto the
  // resolved swapchain, so it does NOT participate.
  const resolveOwner = deriveResolveOwner({ hasPoints, hasHillshade, hasTranslucent })
  return {
    opaque,
    translucent,
    oit,
    opaqueGroups,
    hasTranslucent,
    hasOit,
    hasPoints,
    hasHeatmap,
    hasHillshade,
    hasGraphics,
    hasFlow,
    resolveOwner,
    // DERIVED from the frame's two geometries, not remembered — the loop set
    // them from the one setFrameTargets site, so the flag cannot disagree
    // with the targets the passes actually attach (#1429 INC-2).
    sceneScaled: ctx.scene.w !== ctx.screen.w || ctx.scene.h !== ctx.screen.h,
  }
}
