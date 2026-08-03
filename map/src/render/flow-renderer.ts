// ═══ FlowRenderer — the IBFV advection arm (#1333) ═══
//
// Owns everything the flow layer needs on the GPU: the ping-pong pair (via FlowStepper), the
// advect pipeline, and the sampler — the same ownership shape CoverageRenderer has, so the map
// gains ONE member rather than four and the render pass stays a scheduling decision.
//
// TWO THINGS THIS OWNS THAT NOTHING ELSE CAN:
//
// 1. THE FORMAT AGREEMENT. The pair's storage format is chosen from a device capability
//    (r16float when the backend can render into one, else the rgba8unorm floor —
//    flow-targets.ts), and the advect PIPELINE must be built for that same format. Splitting the
//    two across owners is how they drift: a pipeline compiled for r16float rendering into an
//    rgba8unorm attachment is a pipeline/attachment mismatch, which is a validation error on
//    WebGPU and a silently wrong image on WebGL2. Here they are decided in one place, and the
//    pipeline is rebuilt when the format changes.
//
// 2. THE BACKEND FORK. Beginning a pass into an offscreen attachment is the one thing the two
//    backends do differently: WebGPU records into the frame's command encoder, WebGL2 binds an
//    FBO inside the live screen pass (RhiDevice.beginOffscreenPass). Both consume the SAME
//    RhiRenderPassDesc, so the fork is two lines and the descriptor cannot diverge.
//
// NO WEBGPU TYPE APPEARS BELOW, and that is deliberate rather than incidental. CoverageRenderer
// still names `GPURenderPassEncoder` because it was written before the frame encoder was
// RHI-typed; this arm takes `RhiCommandEncoder` off the FrameContext instead, so it is inside
// both the concrete-backend-import ratchet (#991) and the raw-WebGPU ratchet with no baseline
// entry — the F3/P5 direction, arriving one pass at a time.

import { asScreenPassDevice } from '@xgis/engine'
import type {
  RhiBindGroup,
  RhiCommandEncoder,
  RhiDevice,
  RhiSampler,
  RhiRenderPass,
  RhiRenderPassDesc,
  RhiTextureView,
  RhiTextureFormat,
} from '@xgis/engine'
import type { FlowFieldRegion } from './coverage-renderer'
import { FlowStepper, FLOW_STEP_DEFAULTS, type FlowStepOptions } from './flow-stepper'
import { FlowAdvectDraper, packFlowAdvectUniform } from './material/flow-advect-material'

/** What one step needs from the frame — deliberately these two fields rather than the whole
 *  FrameContext, because the forced-WebGL2 twin has none: it early-returns from
 *  `RenderLoop.render` before the loop builds one (render-loop.ts:265). */
export interface FlowFrame {
  /** Frame clock in ms — where the step's dt comes from. */
  elapsedMs: number
  /** THIS frame's encoder (`FrameContext.rhiEncoder`), or null on the WebGL2 twin, which begins
   *  its offscreen pass off the DEVICE inside the live screen pass and needs none. Handed in
   *  rather than fetched: `rhi.acquireFrameEncoder()` MINTS a fresh native encoder per call, so
   *  reaching for it mid-frame would strand these commands outside the frame's single submit. */
  encoder: RhiCommandEncoder | null
}

export class FlowRenderer {
  private readonly stepper = new FlowStepper()
  private draper: FlowAdvectDraper | null = null
  /** The format `draper` was built for — the pipeline/attachment agreement (see the header). */
  private draperFormat: RhiTextureFormat | null = null
  private sampler: RhiSampler | null = null
  /** Bind groups keyed by the READ side. The pair alternates between exactly two, so this
   *  settles at two entries and the 60 Hz path stops minting a GPU object per frame. Dropped
   *  whenever the field views or the pipeline layout change (see `bindGroupFor`). */
  private readonly bindGroups = new Map<RhiTextureView, RhiBindGroup>()
  private bgFieldU: RhiTextureView | null = null
  private bgFieldV: RhiTextureView | null = null

  /** The arrow ping-pong + its step (#1419) — see the section below. */
  private nearest: RhiSampler | null = null
  /** The step's bind groups, per region and then per read side — two entries per region at
   *  rest. Keyed by region because each domain binds a DIFFERENT velocity pair (#1458): one
   *  map keyed by the read side alone would hand the first region's group to every sibling. */
  /** The velocity field each resident region carries. ONE PER REGION, not one for the map —
   *  see `setArrowFields`. */
  private readonly arrowFields = new Map<string, FlowFieldRegion>()

  constructor(private readonly rhi: RhiDevice) {}

  /** Run one advection step for `field`. No-op when the grid is degenerate. */
  step(frame: FlowFrame, field: FlowFieldRegion, opts: FlowStepOptions = FLOW_STEP_DEFAULTS): void {
    // `floatBlendTargets` is the closest cap the RHI exposes; flow-targets.ts records why that
    // is conservative in the safe direction (an 8-bit history, never a broken framebuffer).
    const floatTargets = this.rhi.caps.floatBlendTargets
    const draw = this.stepper.step(
      this.rhi,
      {
        width: field.width,
        height: field.height,
        spanDeg: field.spanDeg,
        midLatDeg: field.midLatDeg,
      },
      this.stepper.consumeDt(frame.elapsedMs),
      floatTargets,
      opts,
    )
    if (!draw) return

    // A fresh pair holds UNDEFINED contents, and a recursive filter does not overwrite them — it
    // feeds on them, so garbage seeded now would persist in the history for the whole session.
    // FlowStepper has already consumed the flag, so this cannot fire twice for one allocation.
    if (draw.clearFirst) {
      this.clearView(frame, draw.read)
      this.clearView(frame, draw.write)
    }

    const draper = this.ensureDraper()
    const sampler = (this.sampler ??= this.rhi.createSampler({ mag: 'linear', min: 'linear' }))
    const pass = this.begin(frame, {
      label: 'flow-advect',
      // `load`, not `clear`: the shader mixes the advected history with fresh noise and writes
      // the result opaquely, so clearing would only discard bytes the draw fully replaces.
      colorAttachments: [{ view: draw.write, loadOp: 'load', storeOp: 'store' }],
    })
    if (!pass) return
    const bg = this.bindGroupFor(draper, draw.read, field, sampler)
    draper.draw(
      pass,
      packFlowAdvectUniform(
        draw.params.stepX,
        draw.params.stepY,
        draw.params.decay,
        draw.params.inject,
        draw.noisePhase,
      ),
      bg,
    )
    pass.end()
  }

  /** The most recently advected image — what the drape samples. Null before the first step. */
  get currentView(): RhiTextureView | null {
    return this.stepper.currentView
  }

  // ── The arrow ping-pong (#1419) ─────────────────────────────────────────────────────────
  //
  // The catalogue glyphs are advected through the SAME velocity pair the trail uses, so their
  // state lives here rather than in a sibling renderer: everything the step reads is already
  // reachable from this object, and a sibling would have to borrow the field views anyway —
  // the coupling without the cohesion. The trail and the arrows are otherwise independent;
  // either can run without the other.

  /** Everything the advected DRAW binds: where the arrows are (read side), where they belong,
   *  and the velocity pair they are stepping through.
   *
   *  All four together, from one place, deliberately: the draw must read the SAME field the step
   *  moved the arrows through, or the glyphs report a forecast hour they are not standing in.
   *  Null until the first step has run — a caller treats that as "no advected draw this frame"
   *  rather than substituting anything. */
  arrowBindingFor(region: string): {
    flowU: RhiTextureView
    flowV: RhiTextureView
  } | null {
    const field = this.arrowFields.get(region)
    return field ? { flowU: field.u, flowV: field.v } : null
  }

  /** Declare which velocity pair EACH resident region's arrows are stepping through — an empty
   *  map when no region carries one any more.
   *
   *  ONE PAIR PER REGION, and that is the whole of #1458's second half. This used to be a single
   *  pair, fed from `CoverageRenderer.activeFlowField()` — the FIRST resident region's field —
   *  and handed to every advected batch whatever domain it belonged to. The arrows still landed
   *  in roughly the right places (screen position comes from the CPU-packed per-instance
   *  lon/lat, and `pos`/`origin` are read from the same texel so the leash held), which is why
   *  a coverage metric could not see it. What was wrong is everything DERIVED from the field: a
   *  sibling domain's arrows took their band colour, heading and scale from another domain's
   *  water, and were advected through its degree span and centre latitude as well — from frame
   *  zero, not as accumulated drift.
   *
   *  Called by the flow pass EVERY frame. That is a LIFETIME requirement, not a freshness one —
   *  the mosaic evicts a region and DESTROYS its flow textures,
   *  so a binding built from the views held here goes into the next submit pointing at freed
   *  memory:
   *
   *    destroyed texture "coverage-flow-v" used in a submit
   *
   *  reported from S-111 Live by zooming out and panning to another domain (#1419). The views
   *  live exactly as long as the pass keeps saying they do — now per region, so one domain
   *  leaving cannot invalidate a sibling's still-valid pair. */
  setArrowFields(fields: ReadonlyMap<string, FlowFieldRegion>): void {
    for (const [region, field] of fields) {
      const prev = this.arrowFields.get(region)
      if (prev?.u === field.u && prev.v === field.v) continue
      // Only THIS region's cached groups were built against the outgoing pair.
      this.arrowFields.set(region, field)
    }
    for (const region of [...this.arrowFields.keys()]) {
      if (fields.has(region)) continue
      this.arrowFields.delete(region)
    }
  }

  dispose(): void {
    this.stepper.destroy()
    if (this.sampler) this.rhi.destroySampler(this.sampler)
    if (this.nearest) this.rhi.destroySampler(this.nearest)
    this.sampler = null
    this.nearest = null
    this.arrowFields.clear()
    this.draper = null
    this.draperFormat = null
    this.bindGroups.clear()
    this.bgFieldU = this.bgFieldV = null
  }

  /** Build (or rebuild) the advect pipeline for the pair's CURRENT storage format. Rebuilding on
   *  a format change is not defensive: a device swap can move the pair between r16float and the
   *  rgba8unorm floor, and a pipeline still compiled for the old one mismatches its attachment. */
  private ensureDraper(): FlowAdvectDraper {
    const fmt = this.stepper.targets.storageFormat
    if (!this.draper || this.draperFormat !== fmt) {
      this.draper = new FlowAdvectDraper(this.rhi, fmt)
      this.draperFormat = fmt
      // The cached groups were built against the OLD pipeline's layout.
      this.bindGroups.clear()
    }
    return this.draper
  }

  /** The step's bind group, memoized per read side. Invalidated when the coverage re-arms (new
   *  field views — stepping the forecast hour does this every time), so a stale group can never
   *  keep the previous hour's velocities bound. */
  private bindGroupFor(
    draper: FlowAdvectDraper,
    read: RhiTextureView,
    field: FlowFieldRegion,
    sampler: RhiSampler,
  ): RhiBindGroup {
    if (field.u !== this.bgFieldU || field.v !== this.bgFieldV) {
      this.bindGroups.clear()
      this.bgFieldU = field.u
      this.bgFieldV = field.v
    }
    let bg = this.bindGroups.get(read)
    if (!bg) {
      bg = draper.bindGroup(read, field.u, field.v, sampler)
      this.bindGroups.set(read, bg)
    }
    return bg
  }

  /** Wipe one side of the pair — a pass with a clear load-op and no draw. */
  private clearView(frame: FlowFrame, view: RhiTextureView): void {
    const pass = this.begin(frame, {
      label: 'flow-clear',
      colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
    })
    pass?.end()
  }

  /** THE fork (see the header). WebGL2 nests an FBO pass inside the live screen pass; every
   *  other backend records into this frame's encoder. Null when neither is available — the
   *  twin frame carries no RHI encoder — which skips the step rather than
   *  throwing into the render loop. */
  private begin(frame: FlowFrame, desc: RhiRenderPassDesc): RhiRenderPass | null {
    const gl2 = asScreenPassDevice(this.rhi)
    if (gl2) return gl2.beginOffscreenPass(desc)
    return frame.encoder?.beginRenderPass(desc) ?? null
  }
}
