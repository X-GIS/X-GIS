// Device-free unit test for RenderTargets.ensure — pins the recreate-on-
// resize lifecycle (the gate + destroy-old order + format/usage choices)
// extracted VERBATIM from RenderLoop. Runs against an instrumented fake
// device (the webgpu-stub installs the GPUTextureUsage int-enum globals the
// production code reads as `GPUTextureUsage.RENDER_ATTACHMENT`).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { installWebGPUStub, type StubInstallation } from '../../__test-support__/webgpu-stub'
import { RenderTargets } from '@xgis/rhi-webgpu'
import type { GPUContext } from '@xgis/rhi-webgpu'

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
        destroy() {
          this.destroyed = true
        },
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
  beforeEach(() => {
    stub = installWebGPUStub()
  })
  afterEach(() => {
    stub.uninstall()
  })

  it('allocates ONLY stencil on first ensure (no MSAA, no pick, no overdraw); OIT/extrude are lazy', () => {
    const fake = makeFakeDevice()
    const rt = new RenderTargets(() => makeCtx(fake.device))

    const { useResolve, colorView } = rt.ensure(800, 600, 1, false, false, screenView)

    expect(useResolve).toBe(false)
    // sc === 1 → no MSAA texture, no pick (disabled), no overdraw.
    expect(rt.msaaTexture).toBeNull()
    expect(rt.pickTexture).toBeNull()
    expect(rt.overdrawAccumTexture).toBeNull()
    // stencil allocated + its view cached.
    expect(rt.stencilTexture).not.toBeNull()
    expect(rt.stencilView).not.toBeNull()
    // OIT + offscreen-extrude are NOT allocated by ensure() — they are lazy
    // (ensureOit), gated on scene OIT content. Default path allocates none.
    expect(rt.oitAccumTexture).toBeNull()
    expect(rt.oitRevealageTexture).toBeNull()
    expect(rt.offscreenExtrudeDepth).toBeNull()
    expect(rt.msaaWidth).toBe(800)
    expect(rt.msaaHeight).toBe(600)
    // sc === 1 → colorView is the swapchain view directly.
    expect(colorView).toBe(screenView)
    // 1 texture created (stencil only).
    expect(fake.created.length).toBe(1)
  })

  it('allocates MSAA + pick + overdraw when those inputs are on (still no OIT)', () => {
    const fake = makeFakeDevice()
    const rt = new RenderTargets(() => makeCtx(fake.device))

    const { useResolve, colorView } = rt.ensure(640, 480, 4, true, true, screenView)

    expect(useResolve).toBe(true)
    expect(rt.msaaTexture).not.toBeNull()
    expect(rt.pickTexture).not.toBeNull()
    expect(rt.overdrawAccumTexture).not.toBeNull()
    // Cached views populated alongside their textures.
    expect(rt.msaaView).not.toBeNull()
    expect(rt.pickView).not.toBeNull()
    expect(rt.overdrawView).not.toBeNull()
    // OIT still not allocated by ensure().
    expect(rt.oitAccumTexture).toBeNull()
    // debug-overdraw → colorView is the accumulator view, not screenView.
    expect(colorView).not.toBe(screenView)
    // msaa(format bgra8unorm), stencil, pick(rg32uint sc1), overdrawAccum = 4.
    expect(fake.created.length).toBe(4)
    const msaa = rt.msaaTexture as unknown as FakeTexture
    expect(msaa.descriptor.format).toBe('bgra8unorm')
    expect(msaa.descriptor.sampleCount).toBe(4)
    const pick = rt.pickTexture as unknown as FakeTexture
    expect(pick.descriptor.format).toBe('rg32uint')
    // pick stays single-sample regardless of the opaque sample count.
    expect(pick.descriptor.sampleCount).toBe(1)
  })

  it('ensureOit lazily allocates the 3 OIT targets once, recreates on size/sample change', () => {
    const fake = makeFakeDevice()
    const rt = new RenderTargets(() => makeCtx(fake.device))
    rt.ensure(800, 600, 1, false, false, screenView)
    const afterEnsure = fake.created.length // stencil only

    rt.ensureOit(800, 600, 1)
    // oitAccum + oitRevealage + offscreenExtrudeDepth = 3, views cached.
    expect(fake.created.length).toBe(afterEnsure + 3)
    expect(rt.oitAccumTexture).not.toBeNull()
    expect(rt.oitRevealageTexture).not.toBeNull()
    expect(rt.offscreenExtrudeDepth).not.toBeNull()
    expect(rt.oitAccumView).not.toBeNull()
    expect(rt.oitRevealageView).not.toBeNull()

    // Same size + sample count → no recreate.
    rt.ensureOit(800, 600, 1)
    expect(fake.created.length).toBe(afterEnsure + 3)

    // Sample-count change → recreate (OIT must match the opaque sample count).
    rt.ensureOit(800, 600, 4)
    expect(fake.created.length).toBe(afterEnsure + 6)
    const accum = rt.oitAccumTexture as unknown as FakeTexture
    expect(accum.descriptor.sampleCount).toBe(4)
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

  it('view getters self-heal across a resize — never hand back a stale view', () => {
    // The desync trap the identity-keyed cache exists to prevent: after a
    // resize recreates stencilTexture, stencilView MUST derive from the NEW
    // texture, not a view cached against the destroyed one.
    const fake = makeFakeDevice()
    const rt = new RenderTargets(() => makeCtx(fake.device))

    rt.ensure(800, 600, 1, false, false, screenView)
    const texA = rt.stencilTexture
    const viewA = rt.stencilView
    expect(viewA).not.toBeNull()
    // Same texture → same cached view object (no per-call allocation).
    expect(rt.stencilView).toBe(viewA)

    rt.ensure(1024, 768, 1, false, false, screenView)
    expect(rt.stencilTexture).not.toBe(texA) // recreated
    // The getter now derives from the new texture: a different view object,
    // and never the one bound to the destroyed texture.
    expect(rt.stencilView).not.toBe(viewA)
    expect(rt.stencilView).not.toBeNull()
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
