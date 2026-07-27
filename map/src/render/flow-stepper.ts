// ═══ IBFV advection step sequencing (#1333) ═══
//
// Drives ONE advection step over the ping-pong pair. Small, but the ORDER is the correctness:
// a recursive filter that clears at the wrong moment, or swaps at the wrong moment, produces a
// picture that still animates and is still wrong — and this environment has no GPU to notice.
// So the sequence lives here, behind a draw seam, where it is verifiable without a device.
//
// THE SEQUENCE, and why each step is where it is:
//
//   1. ensure   — allocate/resize the pair for THIS coverage's grid.
//   2. clear    — ONLY when the pair is fresh. Undefined texture contents are not overwritten
//                 by a recursive filter, they are FED ON, so they would persist in the history
//                 indefinitely. Clearing every frame is the opposite failure: the animation
//                 would never accumulate a trail. `needsClear` distinguishes the two, and it is
//                 consumed here so no caller can forget.
//   3. advect   — read the history side, write the target side. Never the same texture: a
//                 sampler reading the attachment it writes is undefined behaviour on both
//                 backends.
//   4. swap     — AFTER the draw. Swapping first would advect into the history and read the
//                 stale target, which silently halves the effective frame rate and doubles the
//                 trail length.
//
// The draw itself is injected rather than built here, so this sequencing is testable against a
// recorder and the pass can supply the real material.

import { FlowTargets } from './flow-targets'
import { flowAdvectParams, type FlowAdvectParams } from './flow-advect-params'
import type { RhiDevice, RhiTextureView } from '@xgis/engine'

/** What the pass must draw for one step. `read` is the history, `write` is the attachment. */
export interface FlowStepDraw {
  read: RhiTextureView
  write: RhiTextureView
  params: FlowAdvectParams
  noisePhase: number
}

/** The velocity field a step advects through — what CoverageRenderer.flowField() returns,
 *  plus the geometry the uv arithmetic needs. */
export interface FlowStepField {
  width: number
  height: number
  /** Grid extent in degrees, [lon, lat]. */
  spanDeg: readonly [number, number]
  /** Latitude at the middle of the cell. */
  midLatDeg: number
}

export interface FlowStepOptions {
  /** uv travelled per second at the field's peak speed — the display rate (see
   *  flow-advect-params.ts on why this is a look control, not a physical rate). */
  ratePerSec: number
  decay: number
  inject: number
}

/** Sensible starting values. NOT tuned — this environment has no GPU, so these are principled
 *  defaults that need a look before they are called right (design §7). */
export const FLOW_STEP_DEFAULTS: FlowStepOptions = {
  ratePerSec: 0.06,
  decay: 0.96,
  inject: 0.07,
}

export class FlowStepper {
  readonly targets = new FlowTargets()
  /** Advances every step; the shader hashes it so the injected noise is not a frozen pattern. */
  private phase = 0
  /** Frame clock at the previous `consumeDt`; null before the first one. */
  private lastElapsedMs: number | null = null

  /** Seconds since the previous call, from the frame clock. The delta lives HERE rather than on
   *  the render pass because passes are stateless singletons, and the history this delta
   *  advances is this stepper's. The FIRST call returns 0 — there is no earlier frame the
   *  history could have been advected across, and inventing one would advect a just-cleared
   *  field by a whole startup interval. Larger deltas are clamped downstream
   *  (FLOW_MAX_DT_SECONDS), so a restored tab cannot teleport the field either. */
  consumeDt(elapsedMs: number): number {
    const prev = this.lastElapsedMs
    this.lastElapsedMs = elapsedMs
    return prev === null ? 0 : Math.max(0, (elapsedMs - prev) / 1000)
  }

  /** Run one advection step. Returns the draw the caller must issue, or null when there is
   *  nothing to advect — a scalar coverage, or a degenerate grid. Returning the draw rather
   *  than issuing it keeps the sequencing testable and leaves encoder ownership with the pass.
   *
   *  `clearFirst` in the result is the fresh-pair obligation; the caller MUST honour it before
   *  the draw, and this method has already consumed the flag so it cannot fire twice. */
  step(
    rhi: RhiDevice,
    field: FlowStepField,
    dtSeconds: number,
    floatRenderTargets: boolean,
    opts: FlowStepOptions = FLOW_STEP_DEFAULTS,
  ): (FlowStepDraw & { clearFirst: boolean }) | null {
    if (field.width <= 0 || field.height <= 0) return null

    this.targets.ensure(rhi, field.width, field.height, floatRenderTargets)
    const read = this.targets.readView
    const write = this.targets.writeView
    if (!read || !write) return null

    const clearFirst = this.targets.needsClear
    if (clearFirst) this.targets.markCleared()

    const params = flowAdvectParams({
      spanDeg: field.spanDeg,
      midLatDeg: field.midLatDeg,
      dtSeconds,
      ratePerSec: opts.ratePerSec,
      decay: opts.decay,
      inject: opts.inject,
    })

    // Phase advances on the STEP, not on wall-clock: a dropped frame must not jump the noise
    // pattern, because the history was not advected across that gap either.
    this.phase = (this.phase + 1) % 4096

    // Swap AFTER capturing the views — the draw the caller issues uses the pre-swap pair, and
    // the next step reads what this one wrote.
    this.targets.swap()

    return { read, write, params, noisePhase: this.phase, clearFirst }
  }

  /** The side holding the most recently advected image — what the drape samples. Null before
   *  the first step. Note this is the READ side after the swap, which is exactly the texture
   *  the step just wrote. */
  get currentView(): RhiTextureView | null {
    return this.targets.readView
  }

  destroy(): void {
    this.targets.destroy()
    this.phase = 0
    // The pair is gone, so the next step starts from a cleared history — a stale clock would
    // hand that fresh field the whole destroyed-to-restored gap as its first dt.
    this.lastElapsedMs = null
  }
}
