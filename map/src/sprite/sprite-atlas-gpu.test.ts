// SpriteAtlasGPU RHI-twin texture usage contract (#777 I-E fix), GPU-free.
//
// rhiView() builds the backend-blind atlas twin via rhi.createTexture and
// uploads it via rhi.copyExternalImage — whose WebGPU mapping is
// queue.copyExternalImageToTexture. The WebGPU spec requires that copy's
// DESTINATION texture to carry RENDER_ATTACHMENT ('render') in addition to
// COPY_DST ('copy-dst'): the browser may blit through an internal render pass
// for colourspace/premultiply conversion. The native ensure() path already
// carries RENDER_ATTACHMENT (and is what the WebGPU icon flow binds), but the
// twin was only ever exercised under forced WebGL2 — which ignores usage bits —
// so a missing 'render' stayed latent until the background-pattern pass read
// rhiView() on a WebGPU device and Dawn rejected the upload:
//   "Destination texture needs to have CopyDst and RenderAttachment usage."
//
// Fail-before: drop 'render' from the rhiView() createTexture usage
// (sprite-atlas-gpu.ts) — the usage-contract assertion below goes red.

import { describe, it, expect } from 'vitest'
import { SpriteAtlasGPU } from './sprite-atlas-gpu'
import type { SpriteAtlasHost } from './sprite-atlas-host'
import type { RhiDevice } from '@xgis/engine'

interface CreatedTex {
  desc: {
    width: number
    height: number
    format: string
    usage: readonly string[]
    label?: string
  }
  handle: object
}

function makeStubs(): {
  rhi: RhiDevice
  host: SpriteAtlasHost
  created: CreatedTex[]
  copies: Array<{ texture: object; width: number; height: number }>
} {
  const created: CreatedTex[] = []
  const copies: Array<{ texture: object; width: number; height: number }> = []
  const rhi = {
    createTexture: (desc: CreatedTex['desc']) => {
      const handle = { __stub: `tex${created.length}` }
      created.push({ desc, handle })
      return handle
    },
    copyExternalImage: (texture: object, _src: unknown, width: number, height: number) => {
      copies.push({ texture, width, height })
    },
    createView: (texture: object) => ({ __stubView: texture }),
    createSampler: () => ({ __stubSampler: true }),
  } as unknown as RhiDevice
  // A loaded host with a 64×32 decoded raster — rhiView() only reads
  // getState() + getImage(), so a structural stub suffices.
  const host = {
    getState: () => ({ status: 'loaded' }),
    getImage: () => ({ width: 64, height: 32 }),
  } as unknown as SpriteAtlasHost
  return { rhi, host, created, copies }
}

describe('SpriteAtlasGPU.rhiView() — copyExternalImage destination usage contract', () => {
  it("creates the RHI twin with 'render' + 'copy-dst' + 'sample' usage (fail-before: 'render' missing)", () => {
    const { rhi, host, created } = makeStubs()
    // device is never touched by rhiView() — the native arm owns it.
    const gpu = new SpriteAtlasGPU(null as never, host, rhi)
    const view = gpu.rhiView()
    expect(view).not.toBeNull()
    expect(created).toHaveLength(1)
    const usage = created[0]!.desc.usage
    // The WebGPU copyExternalImageToTexture destination rule: COPY_DST AND
    // RENDER_ATTACHMENT. 'sample' because the pattern/icon FS binds it.
    expect(usage).toContain('copy-dst')
    expect(usage).toContain('render')
    expect(usage).toContain('sample')
    expect(created[0]!.desc.format).toBe('rgba8unorm')
    expect(created[0]!.desc.width).toBe(64)
    expect(created[0]!.desc.height).toBe(32)
  })

  it('uploads via copyExternalImage into the SAME texture whose usage was pinned', () => {
    const { rhi, host, created, copies } = makeStubs()
    const gpu = new SpriteAtlasGPU(null as never, host, rhi)
    gpu.rhiView()
    expect(copies).toHaveLength(1)
    // Identity: the pinned-usage texture IS the copy destination — the pair the
    // Dawn validation rule binds together.
    expect(copies[0]!.texture).toBe(created[0]!.handle)
    expect(copies[0]!.width).toBe(64)
    expect(copies[0]!.height).toBe(32)
  })

  it('is idempotent — a second rhiView() reuses the twin (no second create/upload)', () => {
    const { rhi, host, created, copies } = makeStubs()
    const gpu = new SpriteAtlasGPU(null as never, host, rhi)
    const v1 = gpu.rhiView()
    const v2 = gpu.rhiView()
    expect(v2).toBe(v1)
    expect(created).toHaveLength(1)
    expect(copies).toHaveLength(1)
  })

  it('returns null (no create, no upload) while the host is still loading', () => {
    const { rhi, created, copies } = makeStubs()
    const loadingHost = {
      getState: () => ({ status: 'loading' }),
      getImage: () => undefined,
    } as unknown as SpriteAtlasHost
    const gpu = new SpriteAtlasGPU(null as never, loadingHost, rhi)
    expect(gpu.rhiView()).toBeNull()
    expect(created).toHaveLength(0)
    expect(copies).toHaveLength(0)
  })
})
