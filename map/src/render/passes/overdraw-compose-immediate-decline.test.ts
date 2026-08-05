// ═══ The overdraw compose DECLINES on an immediate device (#1046 Inc-F2d) ═══
//
// `?debug=overdraw` is the one flag whose pass body is still raw WebGPU (P6):
// it unwraps a native `GPURenderPassEncoder` and calls `ctx.device.createBindGroup`.
// On a WebGL2 device the unwrap throws by design and `ctx.device` is the fail-loud
// stub — so the pass does not render wrongly, it CRASHES the frame, and map.ts
// halts the render loop after three consecutive frame failures.
//
// The accumulator guard (`if (!ctx.rt.overdrawAccumTexture) return`) does NOT
// prevent this. That texture is provisioned on `debugOverdraw` alone, with no
// backend condition (rhi-webgpu/src/render-targets.ts), and Inc-D moved the
// allocation onto `rhi.createTexture` — so a WebGL2 device gets one and walks in.
//
// This is live TODAY on `?rhichain=1&forcegl2=1&debug=overdraw`, and becomes the
// default the moment the twin is deleted — including for the iOS auto-fallback,
// which is a production path and not a dev flag. The forced-WebGL2 twin never had
// the hole: it has no accumulator and no compose at all, so `?debug=overdraw`
// there renders an ordinary map on a transparent clear. Declining reproduces
// exactly that.
//
// `execute` is driven DIRECTLY, as the sibling wiring test does. `shouldRun`
// returns the module-level `DEBUG_OVERDRAW`, which is false under vitest and
// cannot be set from a test — so driving through the scheduler runs neither arm
// and every assertion below would pass vacuously. (The first draft of this file
// did exactly that: both arms silently skipped, and the decline "passed" without
// the gate existing. The deferred case below is what exposed it, which is why it
// is here.) That is also why the capability gate lives in `execute` at all:
// `shouldRun` is handed no FrameContext and so cannot see the device.

import { describe, it, expect, vi } from 'vitest'
import { overdrawComposePass } from './overdraw-compose-pass'
import type { FrameContext } from '../frame-context'
import type { SceneView } from '../scene-view'

/** Drive the pass on a device with the given execution model. */
function run(executionModel: 'immediate' | 'deferred') {
  const beginRenderPass = vi.fn(() => {
    throw new Error(
      'unwrapWebGpuPass: a native-bodied terminal was reached on a non-WebGPU backend',
    )
  })
  const createBindGroup = vi.fn(() => {
    throw new Error('[X-GIS] ctx.device is not available on this backend')
  })
  const ctx = {
    rhi: { caps: { executionModel } },
    rhiEncoder: { beginRenderPass },
    rhiScreenView: { __screen: true },
    rhiColorView: { __color: true },
    rhiStencilView: { __stencil: true },
    rhiSceneResolveView: { __sceneResolve: true },
    rhiColorViewScreen: { __colorScreen: true },
    passScope: (_l: string, fn: () => void) => fn(),
    // Non-null, exactly as a WebGL2 device provisions it under ?debug=overdraw.
    rt: { overdrawAccumTexture: {}, overdrawViewNative: {} },
  } as unknown as FrameContext
  const host = {
    ctx: { device: { createBindGroup } },
    renderer: {
      ensureOverdrawCompose: () => ({ __pipeline: true }),
      overdrawComposeBindGroupLayout: { __layout: true },
    },
  }
  const scene = {} as unknown as SceneView
  let threw: unknown = null
  try {
    overdrawComposePass.execute(ctx, scene, host as never)
  } catch (e) {
    threw = e
  }
  return { beginRenderPass, createBindGroup, threw }
}

describe('overdraw-compose — immediate devices decline instead of crashing (#1046 Inc-F2d)', () => {
  it('an IMMEDIATE device never reaches the raw-WebGPU body, and does not throw', () => {
    const { beginRenderPass, createBindGroup, threw } = run('immediate')
    expect(
      threw,
      'the overdraw compose threw on an immediate device — this is the frame-killing crash ' +
        '?debug=overdraw hits on WebGL2 (map.ts halts the loop after three of them)',
    ).toBeNull()
    expect(beginRenderPass, 'the native pass must never be begun there').not.toHaveBeenCalled()
    expect(createBindGroup, 'ctx.device is the fail-loud stub on WebGL2').not.toHaveBeenCalled()
  })

  it('a DEFERRED device still runs the compose (the gate is not a blanket off-switch)', () => {
    // Both directions, so the decline cannot pass vacuously: this arm proves the
    // pass still does its work where the raw body IS valid. It reaches the body
    // and dies on this harness's deliberately-throwing encoder — which is itself
    // the proof that the immediate arm above returned BEFORE that point.
    const { beginRenderPass, threw } = run('deferred')
    expect(beginRenderPass, 'the WebGPU arm must still begin its pass').toHaveBeenCalledTimes(1)
    expect(threw, 'harness encoder throws once entered — proving entry happened').not.toBeNull()
  })
})
