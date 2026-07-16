// ═══ device.lost → observation + internal recovery seed (#1153 B) ═══
//
// Before: device.lost set ctx.deviceLost and (silently) called the public
// onDeviceLost host hook, but there was NO library-internal recovery path — a
// lost device meant a permanent freeze (the render loop stops, nothing restarts
// it). Also a THROWING host hook rejected the .then and was swallowed by .catch.
//
// After: the boot handler isolates the host hook in try/catch and, on a REAL
// fault (reason !== 'destroyed'), fires ctx.onDeviceLostInternal — the seam the
// map wires bounded auto-recovery onto. Intentional teardown ('destroyed') must
// NOT recover (that would resurrect a destroyed map).
//
// Fail-before: onDeviceLostInternal is never called (the internal seam doesn't
// exist), and a throwing host hook prevents any follow-up — both assertions red.

import { describe, it, expect, vi } from 'vitest'
import { createWebGpuContext } from './gpu'

interface LostInfo {
  reason: string
  message: string
}

/** Install a controllable navigator.gpu whose device.lost resolves only when the
 *  test decides (so the hooks are registered BEFORE the handler runs), plus a
 *  webgpu canvas context. Returns the canvas + a resolver + a restore fn. */
function installControllableGpu(): {
  canvas: HTMLCanvasElement
  loseDevice: (info: LostInfo) => void
  restore: () => void
} {
  let loseDevice!: (info: LostInfo) => void
  const lost = new Promise<LostInfo>((res) => {
    loseDevice = res
  })
  const device = {
    features: { has: () => false },
    lost,
    addEventListener: () => undefined,
    queue: { submit: () => undefined },
    destroy: () => undefined,
  }
  const adapter = { features: { has: () => false }, requestDevice: async () => device }
  const gpu = {
    requestAdapter: async () => adapter,
    getPreferredCanvasFormat: () => 'bgra8unorm' as GPUTextureFormat,
  }
  const g = globalThis as unknown as { navigator?: { gpu?: unknown } }
  const navExisted = g.navigator !== undefined
  const priorGpu = g.navigator?.gpu
  if (!g.navigator) g.navigator = {}
  g.navigator.gpu = gpu

  const canvas = {
    width: 8,
    height: 8,
    clientWidth: 8,
    clientHeight: 8,
    getContext: (type: string): unknown =>
      type === 'webgpu'
        ? {
            configure: () => undefined,
            unconfigure: () => undefined,
            getCurrentTexture: () => ({}),
          }
        : null,
  } as unknown as HTMLCanvasElement

  return {
    canvas,
    loseDevice,
    restore: () => {
      if (!navExisted) delete (globalThis as { navigator?: unknown }).navigator
      else g.navigator!.gpu = priorGpu
    },
  }
}

/** Await one macrotask so the resolved lost promise's .then + microtasks flush. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('device.lost recovery seed (#1153 B)', () => {
  it('fires onDeviceLostInternal after the public hook — isolating a throwing hook', async () => {
    const { canvas, loseDevice, restore } = installControllableGpu()
    try {
      const ctx = await createWebGpuContext(canvas, { sampleCount: 1 })
      const internal = vi.fn()
      ctx.onDeviceLost = () => {
        throw new Error('host hook boom')
      }
      ctx.onDeviceLostInternal = internal
      loseDevice({ reason: 'unknown', message: 'gpu reset' })
      await flush()
      expect(ctx.deviceLost).toBe(true)
      // A throwing host hook must NOT stop the internal recovery seam.
      expect(internal).toHaveBeenCalledTimes(1)
      expect(internal).toHaveBeenCalledWith({ reason: 'unknown', message: 'gpu reset' })
    } finally {
      restore()
    }
  })

  it('does NOT fire recovery on intentional teardown (reason "destroyed")', async () => {
    const { canvas, loseDevice, restore } = installControllableGpu()
    try {
      const ctx = await createWebGpuContext(canvas, { sampleCount: 1 })
      const internal = vi.fn()
      ctx.onDeviceLostInternal = internal
      loseDevice({ reason: 'destroyed', message: '' })
      await flush()
      expect(ctx.deviceLost).toBe(true)
      expect(internal).not.toHaveBeenCalled()
    } finally {
      restore()
    }
  })
})
