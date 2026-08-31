// circle-pitch-alignment: 'map' flag wiring (GPU-free, fail-before) — #2118.
//
// Sibling of circle-pitch-scale-wiring.test.ts, and deliberately the same shape:
// drive the REAL PointRenderer.addLayer + render() against the WebGPU stub and
// intercept `device.queue.writeBuffer` to read the point uniform the renderer
// actually uploads. Structural inspection of the renderer would not do — the
// question is what reaches the GPU.
//
// The runtime contract, which is NOT the sibling's:
//
//  · circle_params.w is a MODE CODE, not a flag: 0 = viewport/viewport,
//    1 = viewport align + map scale, 2 = map align. It is an enum because the two
//    knobs stop being independent once the disc leaves the screen plane — under
//    alignment:map the ground basis ALREADY carries the distance foreshortening,
//    so mode 2 must NOT also take mode 1's w_ref/clip.w radius multiplier. A bit
//    field would let both fire and count the perspective twice.
//  · mvp_pitch0 (f32 slots 44..59) carries the pitch-0 MVP the basis divides by —
//    but only when a layer actually asked for ground alignment. Otherwise it
//    carries the LIVE matrix, so the lane is never stale garbage.
//  · AN UNPITCHED CAMERA SUPPRESSES THE WHOLE MODE, on `pitch` rather than on the
//    computed basis (the same short-circuit `makeGroundBasisFor` takes). That is
//    what makes "an unpitched frame is bit-identical to before #2118" a property
//    of the code instead of a float argument, and it is the regression rung #2118
//    is gated on.
//
// FAIL-BEFORE, one cut per message:
//   · drop `circlePitchAlignmentMap` from the `writePointFrameUniform` call in
//     PointRenderer.drawLayer → 'mode 2 at pitch 60' goes red (reads 0), the
//     pitch-0 and scale rows stay green.
//   · delete the `camera.pitch > 0` term in writePointFrameUniform → ONLY
//     'suppressed at pitch 0' goes red (reads 2), every other row stays green.
//   · make mode 2 fall through to mode 1's arm (a bit test instead of the enum)
//     → 'alignment wins over an explicit scale:map' goes red.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  installWebGPUStub,
  type StubInstallation,
} from '../../../rhi-webgpu/src/__test-support__/webgpu-stub'
import { initGPU, type GPUContext } from '@xgis/rhi-webgpu'
import { PointRenderer, pointUniformBytes } from '@xgis/map'
import { WebGpuDevice } from '@xgis/rhi-webgpu'
import { Camera } from '@xgis/map'

let stub: StubInstallation

beforeEach(() => {
  if (typeof HTMLCanvasElement === 'undefined') {
    ;(globalThis as { HTMLCanvasElement?: unknown }).HTMLCanvasElement = class {
      width = 800
      height = 600
      getContext(_t: string): unknown {
        return null
      }
    } as never
  }
  stub = installWebGPUStub()
})
afterEach(() => {
  stub.uninstall()
})

async function makeCtx(): Promise<GPUContext> {
  const canvas = { width: 1024, height: 768 } as unknown as HTMLCanvasElement
  Object.setPrototypeOf(canvas, HTMLCanvasElement.prototype)
  return initGPU(canvas) as unknown as Promise<GPUContext>
}

const FEATURES = [{ geometry: { type: 'Point', coordinates: [10, 20] } }]
const FILL: [number, number, number, number] = [1, 0, 0, 1]
const W = 1024
const H = 768

// Slots from the SAME contract point-uniform-layout.test.ts pins (mvp 0,
// proj_params 16, viewport 20, cam_ecef_h 24, cam_ecef_l 28, circle_params 32,
// globe_eye 36, zoom 40, mvp_pitch0 44), never hand-counted here.
const U_MVP = 0
const CIRCLE_PARAMS_W = 35
const U_MVP_PITCH0 = 44

interface Captured {
  readonly mode: number
  readonly mvp: readonly number[]
  readonly mvpPitch0: readonly number[]
}

/** Add one opaque circle layer with the given pitch knobs, render a frame at the
 *  given camera pitch, and return what the point uniform actually carried. */
function capture(
  ctx: GPUContext,
  opts: { pitchScaleMap?: boolean; pitchAlignmentMap?: boolean; pitch: number },
): Captured {
  const renderer = new PointRenderer({
    device: ctx.device,
    format: ctx.format,
    rhi: new WebGpuDevice(ctx.device),
  })
  // Positional tail: …, circlePitchScaleMap, perFeatureFills, perFeatureStrokes,
  // shaderVariant, circlePitchAlignmentMap. The new knob is LAST for the reason
  // point-renderer.ts states — every call site here is positional.
  renderer.addLayer(
    FEATURES as never,
    FILL,
    null,
    0,
    8,
    1,
    null,
    null,
    true,
    undefined,
    undefined,
    null,
    0,
    0,
    0,
    null,
    null,
    null,
    opts.pitchScaleMap ?? false,
    null,
    null,
    null,
    opts.pitchAlignmentMap ?? false,
  )

  const UNIFORM_BYTES = pointUniformBytes()
  const SLOT_COUNT = UNIFORM_BYTES / 4
  let out: Captured | null = null
  const device = ctx.device as unknown as {
    queue: { writeBuffer: (buf: unknown, off: number, data: ArrayBufferView | ArrayBuffer) => void }
  }
  device.queue.writeBuffer = (
    buf: unknown,
    _off: number,
    data: ArrayBufferView | ArrayBuffer,
  ): void => {
    if ((buf as { size?: number })?.size !== UNIFORM_BYTES) return
    const f32 =
      data instanceof ArrayBuffer
        ? new Float32Array(data)
        : new Float32Array(
            (data as ArrayBufferView).buffer,
            (data as ArrayBufferView).byteOffset,
            SLOT_COUNT,
          )
    out = {
      mode: f32[CIRCLE_PARAMS_W]!,
      mvp: [...f32.subarray(U_MVP, U_MVP + 16)],
      mvpPitch0: [...f32.subarray(U_MVP_PITCH0, U_MVP_PITCH0 + 16)],
    }
  }

  const camera = new Camera(10, 20, 8)
  camera.projType = 0
  camera.pitch = opts.pitch
  const encoder = (
    ctx.device as unknown as {
      createCommandEncoder: () => { beginRenderPass: () => GPURenderPassEncoder }
    }
  ).createCommandEncoder()
  const pass = encoder.beginRenderPass()
  renderer.render(pass, camera, 0, 10, 20, W, H, 1)

  if (out === null) throw new Error('no point uniform write was captured')
  return out
}

describe('#2118 circle-pitch-alignment map — point uniform wiring (GPU-free)', () => {
  it('mode 2 at pitch 60, and mvp_pitch0 is a DIFFERENT matrix from the live one', async () => {
    const ctx = await makeCtx()
    const c = capture(ctx, { pitchAlignmentMap: true, pitch: 60 })
    expect(c.mode).toBe(2)
    // The lane carrying a matrix is not evidence — it carries the LIVE matrix in
    // the off case by design, so "mvp_pitch0 is populated" would pass with the
    // pitch-0 producer never called at all. What distinguishes the two is that a
    // pitched camera's pitch-0 twin DIFFERS from it.
    expect(c.mvpPitch0).not.toEqual(c.mvp)
    expect(c.mvpPitch0.every((v) => Number.isFinite(v))).toBe(true)
  })

  it('suppressed at pitch 0 — mode 0, and the lane falls back to the live matrix', async () => {
    const ctx = await makeCtx()
    const c = capture(ctx, { pitchAlignmentMap: true, pitch: 0 })
    // The regression rung: an unpitched frame must be indistinguishable from one
    // rendered before this feature existed, and mode 0 is what makes the VS take
    // literally the same arithmetic path.
    expect(c.mode).toBe(0)
    expect(c.mvpPitch0).toEqual(c.mvp)
  })

  it('alignment wins over an explicit scale:map — mode 2, never 1 or 3', async () => {
    const ctx = await makeCtx()
    const c = capture(ctx, { pitchAlignmentMap: true, pitchScaleMap: true, pitch: 60 })
    // Under alignment:map the basis already carries the distance foreshortening.
    // If this ever reads 3 (a bit field) or 1, the VS would apply the radius
    // multiplier on top of a basis that already shrank the disc — the perspective
    // counted twice, which looks like "the feature is too strong", not like a bug.
    expect(c.mode).toBe(2)
  })

  it('the sibling knob is untouched: scale-only is still mode 1, neither is still 0', async () => {
    const ctx = await makeCtx()
    expect(capture(ctx, { pitchScaleMap: true, pitch: 60 }).mode).toBe(1)
    expect(capture(ctx, { pitch: 60 }).mode).toBe(0)
    // …and a scale-only layer never pays for the pitch-0 matrix.
    expect(capture(ctx, { pitchScaleMap: true, pitch: 60 }).mvpPitch0).toEqual(
      capture(ctx, { pitchScaleMap: true, pitch: 60 }).mvp,
    )
  })
})
