// ═══ RenderTargets device-identity guard (#737) ═══
//
// Regression for the deployed /play "switch preset → console error + blank
// map" bug. `map.run()` re-entry (a scene swap) tears down the old GPUDevice
// (`_teardownForReinit` → device.destroy()) and acquires a NEW one, but the
// canvas size is unchanged. The size-keyed recreate gates in `ensure*` then
// short-circuit and hand a render pass on the NEW device a colour / stencil
// attachment still owned by the DESTROYED device — WebGPU rejects it at
// BeginRenderPass ("TextureView … associated with [Device], and cannot be
// used with [Device]") and every frame blanks. The fix keys every `ensure*`
// on device identity (syncDevice) so a device swap drops the cached targets
// and reallocates on the live device.
//
// Content-blind: pure synthetic device/context stubs, no real GPU.

import { describe, it, expect } from 'vitest'
import { RenderTargets } from './render-targets'
import type { GPUContext } from '../gpu/gpu'

// `ensure*` reads GPUTextureUsage flags; stub them for the node test env.
;(globalThis as unknown as { GPUTextureUsage?: Record<string, number> }).GPUTextureUsage ??= {
  RENDER_ATTACHMENT: 0x10,
  COPY_SRC: 0x01,
  TEXTURE_BINDING: 0x04,
}

interface FakeTex { __dev: string; createView: () => { __dev: string }; destroy: () => void }
function makeDevice(id: string) {
  const created: FakeTex[] = []
  const device = {
    id,
    createTexture(): FakeTex {
      const tex: FakeTex = { __dev: id, createView: () => ({ __dev: id }), destroy() {} }
      created.push(tex)
      return tex
    },
  }
  return { device, created }
}
const makeCtx = (device: unknown): GPUContext =>
  ({ device, format: 'bgra8unorm' } as unknown as GPUContext)
const screenView = { __dev: 'screen' } as unknown as GPUTextureView
const devOf = (v: GPUTextureView): string => (v as unknown as { __dev: string }).__dev

describe('RenderTargets — device-identity guard (#737)', () => {
  it('reallocates targets on a device swap at UNCHANGED size (the re-run mismatch)', () => {
    const A = makeDevice('A')
    let ctx = makeCtx(A.device)
    const rt = new RenderTargets(() => ctx)

    // Run 1 — MSAA (sampleCount 4) colour view is allocated on device A.
    const r1 = rt.ensure(800, 600, 4, false, false, screenView)
    expect(r1.useResolve).toBe(true)
    expect(devOf(r1.colorView)).toBe('A')
    expect(A.created.length).toBeGreaterThan(0)

    // Simulate map.run() re-entry: the old device is destroyed and a NEW
    // device B is live, but the canvas size is IDENTICAL.
    const B = makeDevice('B')
    ctx = makeCtx(B.device)
    const r2 = rt.ensure(800, 600, 4, false, false, screenView)

    // Without the guard the size-keyed gate skips recreation and hands back
    // device A's (destroyed) texture → BeginRenderPass validation failure.
    // With the guard the colour view is reallocated on the live device B.
    expect(devOf(r2.colorView)).toBe('B')
    expect(B.created.length).toBeGreaterThan(0)
  })

  it('does NOT reallocate on the SAME device + size (steady-state no-op)', () => {
    const A = makeDevice('A')
    const ctx = makeCtx(A.device)
    const rt = new RenderTargets(() => ctx)

    rt.ensure(800, 600, 4, false, false, screenView)
    const n = A.created.length
    rt.ensure(800, 600, 4, false, false, screenView)
    // Same device, same size → the gate holds; zero new allocations.
    expect(A.created.length).toBe(n)
  })
})
