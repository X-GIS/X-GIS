// ═══ FlowRenderer — the IBFV advection arm (#1333) ═══
//
// Owns everything the flow layer needs on the GPU: the ping-pong pair PER RESIDENT REGION (via
// FlowStepper — #1499), the advect pipeline, and the sampler — the same ownership shape
// CoverageRenderer has, so the map gains ONE member rather than four and the render pass stays a
// scheduling decision.
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

/** ONE region's trail: its ping-pong pair (with its own dt clock), and the bind groups built
 *  against the velocity pair THAT region carries.
 *
 *  Both halves have to be per region, and the second one is the easy half to forget: the groups
 *  are memoized per read side and dropped when the field views change, so a single map shared by
 *  a mosaic would see a different field on every region's step and clear itself each time —
 *  minting a GPU object per region per frame, which is exactly what the memo exists to prevent. */
interface RegionTrail {
  stepper: FlowStepper
  /** Bind groups keyed by the READ side. The pair alternates between exactly two, so this
   *  settles at two entries per region and the 60 Hz path stops minting a GPU object per frame.
   *  Dropped whenever this region's field views or the pipeline layout change. */
  groups: Map<RhiTextureView, RhiBindGroup>
  fieldU: RhiTextureView | null
  fieldV: RhiTextureView | null
}

export class FlowRenderer {
  /** ONE trail PER REGION (#1499) — see `step` and `setTrailRegions`. */
  private readonly trails = new Map<string, RegionTrail>()
  private draper: FlowAdvectDraper | null = null
  /** The format `draper` was built for — the pipeline/attachment agreement (see the header). */
  private draperFormat: RhiTextureFormat | null = null
  private sampler: RhiSampler | null = null

  /** The arrow ping-pong + its step (#1419) — see the section below. */
  private nearest: RhiSampler | null = null
  /** The step's bind groups, per region and then per read side — two entries per region at
   *  rest. Keyed by region because each domain binds a DIFFERENT velocity pair (#1458): one
   *  map keyed by the read side alone would hand the first region's group to every sibling. */
  /** The velocity field each resident region carries. ONE PER REGION, not one for the map —
   *  see `setArrowFields`. */
  private readonly arrowFields = new Map<string, FlowFieldRegion>()

  constructor(private readonly rhi: RhiDevice) {}

  /** Run one advection step for `region`'s `field`. No-op when the grid is degenerate.
   *
   *  PER REGION (#1499). The trail is a RECURSIVE filter over one grid, so a mosaic's domains
   *  cannot share a history: with one pair the map advected the first resident region's field and
   *  every other domain's drape sampled that same image, so a sibling's water stood still —
   *  or rather, moved with another domain's current. Each region therefore owns its pair AND its
   *  dt clock, which is why `consumeDt` is read off THIS region's stepper: a shared clock would
   *  hand the first region of a frame the whole delta and every sibling a zero. */
  step(
    frame: FlowFrame,
    region: string,
    field: FlowFieldRegion,
    opts: FlowStepOptions = FLOW_STEP_DEFAULTS,
  ): void {
    // `floatBlendTargets` is the closest cap the RHI exposes; flow-targets.ts records why that
    // is conservative in the safe direction (an 8-bit history, never a broken framebuffer).
    const floatTargets = this.rhi.caps.floatBlendTargets
    const trail = this.trailFor(region)
    const draw = trail.stepper.step(
      this.rhi,
      {
        width: field.width,
        height: field.height,
        spanDeg: field.spanDeg,
        midLatDeg: field.midLatDeg,
      },
      trail.stepper.consumeDt(frame.elapsedMs),
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

    const draper = this.ensureDraper(trail.stepper.targets.storageFormat)
    const sampler = (this.sampler ??= this.rhi.createSampler({ mag: 'linear', min: 'linear' }))
    const pass = this.begin(frame, {
      label: 'flow-advect',
      // `load`, not `clear`: the shader mixes the advected history with fresh noise and writes
      // the result opaquely, so clearing would only discard bytes the draw fully replaces.
      colorAttachments: [{ view: draw.write, loadOp: 'load', storeOp: 'store' }],
    })
    if (!pass) return
    const bg = this.bindGroupFor(draper, trail, draw.read, field, sampler)
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

  /** The most recently advected image FOR ONE REGION — what that region's drape samples (#1499).
   *  Null before this region's first step, and for a region carrying no trail at all, which the
   *  drape reads as "no motion layer this frame" and multiplies by an exact 1.0. */
  trailViewFor(region: string): RhiTextureView | null {
    return this.trails.get(region)?.stepper.currentView ?? null
  }

  /** Declare which regions have a trail THIS frame — the same every-frame declaration
   *  `setArrowFields` carries, and for the same lifetime reason (#1419/#1458): a region the
   *  mosaic has evicted must not keep a ping-pong pair alive for the rest of the session. The
   *  pair is destroyed here; a sibling's is untouched, which is the whole point of keying it. */
  setTrailRegions(fields: ReadonlyMap<string, FlowFieldRegion>): void {
    // Nothing stepped yet ⇒ nothing to retire, and no snapshot array to mint. The pass calls
    // this EVERY frame, including on maps that will never carry a coverage.
    if (this.trails.size === 0) return
    for (const region of [...this.trails.keys()]) {
      if (fields.has(region)) continue
      this.trails.get(region)?.stepper.destroy()
      this.trails.delete(region)
    }
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
    flowValid: RhiTextureView
  } | null {
    const field = this.arrowFields.get(region)
    return field ? { flowU: field.u, flowV: field.v, flowValid: field.valid } : null
  }

  /** Declare which velocity pair EACH resident region's arrows are stepping through — an empty
   *  map when no region carries one any more.
   *
   *  ONE PAIR PER REGION, and that is the whole of #1458's second half. This used to be a single
   *  pair, fed from the FIRST resident region's field (`CoverageRenderer.activeFlowField()`, since
   *  deleted by #1499), and handed to every advected batch whatever domain it belonged to. The
   *  arrows still landed in roughly the right places (screen position comes from the CPU-packed
   *  per-instance lon/lat, and `pos`/`origin` are read from the same texel so the leash held),
   *  which is why a coverage metric could not see it. What was wrong is everything DERIVED from
   *  the field: a sibling domain's arrows took their band colour, heading and scale from another
   *  domain's water, and were advected through its degree span and centre latitude as well — from
   *  frame zero, not as accumulated drift.
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
    // Nothing declared yet ⇒ nothing to prune, and no snapshot array to mint.
    // The pass calls this EVERY frame now (#1046 Inc-F2c), so the common case on
    // a coverage-less map has to cost zero allocations, not one throwaway array.
    if (this.arrowFields.size === 0) return
    for (const region of [...this.arrowFields.keys()]) {
      if (fields.has(region)) continue
      this.arrowFields.delete(region)
    }
  }

  dispose(): void {
    for (const trail of this.trails.values()) trail.stepper.destroy()
    this.trails.clear()
    if (this.sampler) this.rhi.destroySampler(this.sampler)
    if (this.nearest) this.rhi.destroySampler(this.nearest)
    this.sampler = null
    this.nearest = null
    this.arrowFields.clear()
    this.draper = null
    this.draperFormat = null
  }

  /** This region's trail, minted on its first step. */
  private trailFor(region: string): RegionTrail {
    let trail = this.trails.get(region)
    if (!trail) {
      trail = { stepper: new FlowStepper(), groups: new Map(), fieldU: null, fieldV: null }
      this.trails.set(region, trail)
    }
    return trail
  }

  /** Build (or rebuild) the advect pipeline for the pair's CURRENT storage format. Rebuilding on
   *  a format change is not defensive: a device swap can move the pair between r16float and the
   *  rgba8unorm floor, and a pipeline still compiled for the old one mismatches its attachment.
   *
   *  ONE pipeline for every region: the format comes from a DEVICE capability, so every region's
   *  pair is allocated in the same one and a second pipeline would be the same pipeline twice. */
  private ensureDraper(fmt: RhiTextureFormat): FlowAdvectDraper {
    if (!this.draper || this.draperFormat !== fmt) {
      this.draper = new FlowAdvectDraper(this.rhi, fmt)
      this.draperFormat = fmt
      // The cached groups were built against the OLD pipeline's layout — every region's.
      for (const trail of this.trails.values()) trail.groups.clear()
    }
    return this.draper
  }

  /** The step's bind group, memoized per region and then per read side. Invalidated when that
   *  region re-arms (new field views — stepping the forecast hour does this every time), so a
   *  stale group can never keep the previous hour's velocities bound. */
  private bindGroupFor(
    draper: FlowAdvectDraper,
    trail: RegionTrail,
    read: RhiTextureView,
    field: FlowFieldRegion,
    sampler: RhiSampler,
  ): RhiBindGroup {
    if (field.u !== trail.fieldU || field.v !== trail.fieldV) {
      trail.groups.clear()
      trail.fieldU = field.u
      trail.fieldV = field.v
    }
    let bg = trail.groups.get(read)
    if (!bg) {
      bg = draper.bindGroup(read, field.u, field.v, sampler)
      trail.groups.set(read, bg)
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
