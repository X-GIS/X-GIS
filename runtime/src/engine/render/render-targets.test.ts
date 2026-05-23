// Device-free unit test for RenderTargets.ensure — pins the recreate-on-
// resize lifecycle (the gate + destroy-old order + format/usage choices)
// extracted VERBATIM from RenderLoop. Runs against an instrumented fake
// device (the webgpu-stub installs the GPUTextureUsage int-enum globals the
// production code reads as `GPUTextureUsage.RENDER_ATTACHMENT`).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { installWebGPUStub, type StubInstallation } from '../../__test-support__/webgpu-stub'
import { RenderTargets } from './render-targets'
import type { GPUContext } from '../gpu/gpu'

interface FakeTexture {
  id: number
  descriptor: GPUTextureDescriptor
  destroyed: boolean
  createView: () => GPUTextureView
  destroy: () => void
}

interface FakeDevice {
  created: FakeTexture[]
  device: GPUDevice
}

function makeFakeDevice(): FakeDevice {
  const created: FakeTexture[] = []
  let nextId = 0
  const device = {
    createTexture(descriptor: GPUTextureDescriptor): GPUTexture {
      const tex: FakeTexture = {
        id: nextId++,
        descriptor,
        destroyed: false,
        createView: () => ({}) as GPUTextureView,
        destroy() { this.destroyed = true },
      }
      created.push(tex)
      return tex as unknown as GPUTexture
    },
  } as unknown as GPUDevice
  return { created, device }
}

function makeCtx(device: GPUDevice): GPUContext {
  return { device, format: 'bgra8unorm' } as unknown as GPUContext
}

const screenView = {} as GPUTextureView

describe('RenderTargets.ensure', () => {
  let stub: StubInstallation
  beforeEach(() => { stub = installWebGPUStub() })
  afterEach(() => { stub.uninstall() })

  it('allocates stencil + OIT + offscreen-extrude on first ensure (no MSAA, no pick, no overdraw)', () => {
    const fake = makeFakeDevice()
    const rt = new RenderTargets(() => makeCtx(fake.device))

    const { useResolve, colorView } = rt.ensure(800, 600, 1, false, false, screenView)

    expect(useResolve).toBe(false)
    // sc === 1 → no MSAA texture, no pick (disabled), no overdraw.
    expect(rt.msaaTexture).toBeNull()
    expect(rt.pickTexture).toBeNull()
    expect(rt.overdrawAccumTexture).toBeNull()
    // stencil + oitAccum + oitRevealage + offscreenExtrudeDepth.
    expect(rt.stencilTexture).not.toBeNull()
    expect(rt.oitAccumTexture).not.toBeNull()
    expect(rt.oitRevealageTexture).not.toBeNull()
    expect(rt.offscreenExtrudeDepth).not.toBeNull()
    expect(rt.msaaWidth).toBe(800)
    expect(rt.msaaHeight).toBe(600)
    // sc === 1 → colorView is the swapchain view directly.
    expect(colorView).toBe(screenView)
    // 4 textures created (stencil, oitAccum, oitRevealage, extrudeDepth).
    expect(fake.created.length).toBe(4)
  })

  it('allocates MSAA + pick + overdraw when those inputs are on', () => {
    const fake = makeFakeDevice()
    const rt = new RenderTargets(() => makeCtx(fake.device))

    const { useResolve, colorView } = rt.ensure(640, 480, 4, true, true, screenView)

    expect(useResolve).toBe(true)
    expect(rt.msaaTexture).not.toBeNull()
    expect(rt.pickTexture).not.toBeNull()
    expect(rt.overdrawAccumTexture).not.toBeNull()
    // debug-overdraw → colorView is the accumulator view, not screenView.
    expect(colorView).not.toBe(screenView)
    // msaa(format bgra8unorm), stencil, pick(rg32uint sc1), oitAccum,
    // oitRevealage, extrudeDepth, overdrawAccum = 7.
    expect(fake.created.length).toBe(7)
    const msaa = rt.msaaTexture as unknown as FakeTexture
    expect(msaa.descriptor.format).toBe('bgra8unorm')
    expect(msaa.descriptor.sampleCount).toBe(4)
    const pick = rt.pickTexture as unknown as FakeTexture
    expect(pick.descriptor.format).toBe('rg32uint')
    // pick stays single-sample regardless of the opaque sample count.
    expect(pick.descriptor.sampleCount).toBe(1)
  })

  it('does NOT recreate when ensure is called again at the same size', () => {
    const fake = makeFakeDevice()
    const rt = new RenderTargets(() => makeCtx(fake.device))

    rt.ensure(800, 600, 1, false, false, screenView)
    const countAfterFirst = fake.created.length
    const stencilFirst = rt.stencilTexture

    rt.ensure(800, 600, 1, false, false, screenView)

    // No new textures, same handles.
    expect(fake.created.length).toBe(countAfterFirst)
    expect(rt.stencilTexture).toBe(stencilFirst)
  })

  it('recreates on resize: destroys old then allocates new at the new size', () => {
    const fake = makeFakeDevice()
    const rt = new RenderTargets(() => makeCtx(fake.device))

    rt.ensure(800, 600, 1, false, false, screenView)
    const firstBatch = [...fake.created]
    const countAfterFirst = fake.created.length

    rt.ensure(1024, 768, 1, false, false, screenView)

    // New textures allocated for the new size.
    expect(fake.created.length).toBe(countAfterFirst * 2)
    expect(rt.msaaWidth).toBe(1024)
    expect(rt.msaaHeight).toBe(768)
    // Every first-batch texture was destroyed (recreate-on-resize).
    for (const t of firstBatch) expect(t.destroyed).toBe(true)
    // New stencil sized to the new dimensions.
    const newStencil = rt.stencilTexture as unknown as FakeTexture
    const size = newStencil.descriptor.size as { width: number; height: number }
    expect(size.width).toBe(1024)
    expect(size.height).toBe(768)
  })

  it('invalidate() forces a recreate even when w/h are unchanged', () => {
    const fake = makeFakeDevice()
    const rt = new RenderTargets(() => makeCtx(fake.device))

    rt.ensure(800, 600, 1, false, false, screenView)
    const countAfterFirst = fake.created.length

    // Same size → no recreate without invalidate.
    rt.ensure(800, 600, 1, false, false, screenView)
    expect(fake.created.length).toBe(countAfterFirst)

    // invalidate zeroes the size tracker → next ensure recreates.
    rt.invalidate()
    expect(rt.msaaWidth).toBe(0)
    expect(rt.msaaHeight).toBe(0)
    rt.ensure(800, 600, 1, false, false, screenView)
    expect(fake.created.length).toBe(countAfterFirst * 2)
  })
})
