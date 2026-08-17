// ═══ Flow-field advection pass (#1333) ═══
//
// One IBFV advection step per VISIBLE COVERAGE REGION per rendered frame, into that region's own
// grid-space ping-pong pair (#1499 — a mosaic's domains do not share a history). The coverage
// drape samples the result, so this pass is a PRODUCER and runs BEFORE the consumer — between
// `background` and `opaque`, where the coverage draws (opaque-pass.ts:283).
//
// THAT PLACEMENT IS THE DESIGN, not a scheduling detail. The heatmap pass is a COMPOSITOR and
// therefore runs last; scheduling this one there too would hand the drape LAST frame's
// advection every frame — the animation would still run, one frame stale, which is invisible in
// isolation and wrong under scrubbing. (docs/plans/2026-07-27-grid-vector-field-flow-
// visualization.md §5.1 records why the first draft had it in the heatmap slot.)
//
// It touches NO swapchain attachment — it renders only into its own pair — so it neither claims
// `resolveTarget` nor participates in the colour-clear ownership contract that
// `passes/AGENTS.md` assigns to bucket 0.
//
// The "no flow here" case (every scalar coverage — S-102 bathymetry — and every map with no
// coverage at all) is answered INSIDE execute, not by `shouldRun`: those frames still allocate
// nothing and render byte-identically, but they also DECLARE the empty field, which the frame
// that evicts the last region depends on (see setArrowFields below). NOT gated on the
// flat/globe arm the coverage draw carries either: the consumer that will need that arm is the
// drape (design §6), and the gate belongs with it rather than guessed at here.
//
// The GPU work lives in FlowRenderer (targets + pipeline + the backend fork), exactly as the
// coverage draw lives in CoverageRenderer: this file is the SCHEDULING decision and nothing
// else, so where the step runs stays reviewable on its own.

import { NO_FLOW_FIELDS } from '../coverage-renderer'
import type { FrameContext } from '../frame-context'
import type { SceneView } from '../scene-view'
import type { RenderPass, FlowPassHost } from './pass'

class FlowPass implements RenderPass {
  readonly label = 'flow'

  /** ALWAYS — the declaration below has to happen on the frame the last region
   *  evicts, and that is exactly the frame a `scene.hasFlow` gate would turn
   *  false (hasFlow IS `hasFlowField()`). Gating here swallowed the
   *  before-the-early-return placement the execute body requires, so the arrow
   *  draw kept the evicted region's destroyed textures bound (#1419, found by
   *  #1046 Inc-F2c). The no-allocation property the gate was for is unchanged:
   *  execute returns below without touching a target when there is no field. */
  shouldRun(): boolean {
    return true
  }

  execute(ctx: FrameContext, _scene: SceneView, host: FlowPassHost): void {
    const flow = host.flowRenderer
    if (!flow) return
    // BEFORE the early return, not after it: what the arrow draw binds is whatever this last
    // declared, so a frame with no field has to say so or the draw keeps the evicted region's
    // (now destroyed) textures bound. See `FlowRenderer.setArrowFields`.
    //
    // EVERY region's field: the arrows are per region and read the current they stand in (#1458).
    flow.setArrowFields(host.coverageRenderer?.flowFields() ?? NO_FLOW_FIELDS)
    // The TRAIL is per region too (#1499) — one recursive filter per domain's grid, not one for
    // the map. VISIBLE regions only: under the arrows portrayal they are resident-but-hidden, and
    // advecting a full-screen image nobody draws is a per-frame cost with no picture attached.
    // Declared before the early return for the SAME lifetime reason as the arrows above, so the
    // frame that evicts the last domain retires its ping-pong pair instead of leaking it.
    const trails = host.coverageRenderer?.drapedFlowFields() ?? NO_FLOW_FIELDS
    flow.setTrailRegions(trails)
    if (trails.size === 0) return
    ctx.passScope('flow', () => {
      const frame = { elapsedMs: ctx.elapsedMs, encoder: ctx.rhiEncoder }
      // The arrow field needs NO pass of its own (#1520): an arrow's position is a function of
      // its origin and the frame clock, so there is no state to advance before the graphics pass
      // draws it. What used to run here was a full-texture ping-pong step per resident region.
      // ONE step per region per frame, off the SAME declaration `setTrailRegions` just took — so
      // the set that is stepped and the set that is kept alive cannot disagree.
      for (const [region, field] of trails) flow.step(frame, region, field)
    })
  }
}

export const flowPass: RenderPass = new FlowPass()
