// Gate B (#797 P0) — HostSpriteAtlasGPU shelf allocator + UV math, proven
// analytically with a STUB GPUDevice (no real GPU). We capture the
// createTexture / writeTexture / copyExternalImageToTexture calls and assert:
//   - the recorded SpriteInfo x/y are non-overlapping shelf positions,
//   - UVs (sprite.x/1024, sprite.y/1024) — the exact icon-renderer.ts:268-271
//     formula — are correct,
//   - a page-full image warns + is skipped (never uploaded),
//   - the page texture is allocated ONCE and never recreated (the cached
//     icon bind group invariant).
//
// node lacks `ImageData` / `GPUTextureUsage` globals; both are shimmed below
// (mirroring map-rebuild-layers.characterization.test.ts).

import { describe, it, expect, beforeAll, vi } from 'vitest'
import { HostImageRegistry } from './host-image-registry'
import { HostSpriteAtlasGPU } from './host-sprite-atlas-gpu'

beforeAll(() => {
  const g = globalThis as unknown as Record<string, unknown>
  if (g.ImageData === undefined) {
    g.ImageData = class {
      readonly width: number
      readonly height: number
      readonly data: Uint8ClampedArray
      constructor(width: number, height: number) {
        this.width = width
        this.height = height
        this.data = new Uint8ClampedArray(width * height * 4)
      }
    }
  }
  if (g.GPUTextureUsage === undefined) {
    g.GPUTextureUsage = {
      COPY_SRC: 0x01,
      COPY_DST: 0x02,
      TEXTURE_BINDING: 0x04,
      STORAGE_BINDING: 0x08,
      RENDER_ATTACHMENT: 0x10,
    }
  }
})

interface WriteCall {
  origin: { x: number; y: number; z?: number }
  size: { width: number; height: number }
}

function makeStubDevice() {
  const writeCalls: WriteCall[] = []
  const copyCalls: WriteCall[] = []
  const counters = { createTexture: 0, createView: 0, destroy: 0 }
  const device = {
    createSampler: () => ({ __sampler: true }),
    createTexture: () => {
      counters.createTexture++
      return {
        createView: () => {
          counters.createView++
          return { __view: counters.createView }
        },
        destroy: () => {
          counters.destroy++
        },
      }
    },
    queue: {
      writeTexture: (
        dst: { origin: { x: number; y: number; z?: number } },
        _data: unknown,
        _layout: unknown,
        size: { width: number; height: number },
      ) => {
        writeCalls.push({ origin: dst.origin, size })
      },
      copyExternalImageToTexture: (
        _src: unknown,
        dst: { origin: { x: number; y: number } },
        size: { width: number; height: number },
      ) => {
        copyCalls.push({ origin: dst.origin, size })
      },
    },
  }
  return { device: device as unknown as GPUDevice, writeCalls, copyCalls, counters }
}

describe('HostSpriteAtlasGPU (#797 P0 Gate B)', () => {
  it('packs several images into non-overlapping shelf positions', () => {
    const { device } = makeStubDevice()
    const reg = new HostImageRegistry()
    // Sizes chosen so the shelf wraps predictably against the 1024 page:
    //   a(100×50) b(200×30) fill shelf 0 (x=0,100); shelfH=50
    //   c(800×40): 300+800=1100 > 1024 → new shelf at y=50 (x=0); shelfH=40
    //   d(300×20): 800+300=1100 > 1024 → new shelf at y=90 (x=0)
    reg.addImage('a', new ImageData(100, 50))
    reg.addImage('b', new ImageData(200, 30))
    reg.addImage('c', new ImageData(800, 40))
    reg.addImage('d', new ImageData(300, 20))

    const atlas = new HostSpriteAtlasGPU(device, reg)
    // First get() triggers the pack + upload of every registry entry.
    const a = atlas.get('a')!
    const b = atlas.get('b')!
    const c = atlas.get('c')!
    const d = atlas.get('d')!

    expect([a.x, a.y]).toEqual([0, 0])
    expect([b.x, b.y]).toEqual([100, 0])
    expect([c.x, c.y]).toEqual([0, 50])
    expect([d.x, d.y]).toEqual([0, 90])

    // SpriteInfo width/height/pixelRatio/sdf defaults.
    expect([a.width, a.height, a.pixelRatio, a.sdf]).toEqual([100, 50, 1, false])

    // Non-overlapping: no two packed rects share any interior area.
    const rects = [a, b, c, d]
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const r = rects[i]!
        const s = rects[j]!
        const overlap =
          r.x < s.x + s.width && r.x + r.width > s.x && r.y < s.y + s.height && r.y + r.height > s.y
        expect(overlap).toBe(false)
      }
    }
  })

  it('computes correct UVs via the icon-renderer.ts:268-271 formula', () => {
    const { device } = makeStubDevice()
    const reg = new HostImageRegistry()
    reg.addImage('a', new ImageData(100, 50))
    reg.addImage('b', new ImageData(200, 30))
    const atlas = new HostSpriteAtlasGPU(device, reg)

    expect(atlas.size()).toEqual({ width: 1024, height: 1024 })
    const b = atlas.get('b')!
    const W = atlas.size().width
    const H = atlas.size().height
    // Exact formula the renderer uses.
    expect(b.x / W).toBeCloseTo(100 / 1024, 10)
    expect(b.y / H).toBeCloseTo(0 / 1024, 10)
    expect((b.x + b.width) / W).toBeCloseTo(300 / 1024, 10)
    expect((b.y + b.height) / H).toBeCloseTo(30 / 1024, 10)
  })

  it('region-uploads ImageData via writeTexture at the packed origin', () => {
    const { device, writeCalls } = makeStubDevice()
    const reg = new HostImageRegistry()
    reg.addImage('a', new ImageData(100, 50))
    reg.addImage('b', new ImageData(200, 30))
    const atlas = new HostSpriteAtlasGPU(device, reg)
    atlas.sync()

    expect(writeCalls).toHaveLength(2)
    expect(writeCalls[0]!.origin).toEqual({ x: 0, y: 0, z: 0 })
    expect(writeCalls[0]!.size).toEqual({ width: 100, height: 50 })
    expect(writeCalls[1]!.origin).toEqual({ x: 100, y: 0, z: 0 })
    expect(writeCalls[1]!.size).toEqual({ width: 200, height: 30 })
  })

  it('region-uploads ImageBitmap via copyExternalImageToTexture', () => {
    const { device, copyCalls } = makeStubDevice()
    const reg = new HostImageRegistry()
    // ImageBitmap has no `.data` — the atlas routes it to copyExternalImageToTexture.
    reg.addImage('bmp', { width: 64, height: 64 } as unknown as ImageBitmap)
    const atlas = new HostSpriteAtlasGPU(device, reg)
    atlas.sync()

    expect(copyCalls).toHaveLength(1)
    expect(copyCalls[0]!.origin).toEqual({ x: 0, y: 0 })
    expect(copyCalls[0]!.size).toEqual({ width: 64, height: 64 })
  })

  it('warns + skips an image larger than the page (never uploaded)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { device, writeCalls } = makeStubDevice()
    const reg = new HostImageRegistry()
    reg.addImage('ok', new ImageData(10, 10))
    reg.addImage('toobig', new ImageData(2000, 10)) // width > 1024
    const atlas = new HostSpriteAtlasGPU(device, reg)
    atlas.sync()

    expect(atlas.get('ok')).toBeDefined()
    expect(atlas.get('toobig')).toBeUndefined()
    // Only the fitting image was uploaded.
    expect(writeCalls).toHaveLength(1)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('warns + skips when the page height is exhausted', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { device, writeCalls } = makeStubDevice()
    const reg = new HostImageRegistry()
    // First fills shelf 0 to full height; second opens a new shelf at y=600
    // whose 600px height exceeds the remaining 424px → skipped.
    reg.addImage('tall1', new ImageData(1024, 600))
    reg.addImage('tall2', new ImageData(1024, 600))
    const atlas = new HostSpriteAtlasGPU(device, reg)
    atlas.sync()

    expect(atlas.get('tall1')).toEqual(
      expect.objectContaining({ x: 0, y: 0, width: 1024, height: 600 }),
    )
    expect(atlas.get('tall2')).toBeUndefined()
    expect(writeCalls).toHaveLength(1)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('allocates the page ONCE and never recreates it across uploads', () => {
    const { device, counters } = makeStubDevice()
    const reg = new HostImageRegistry()
    reg.addImage('a', new ImageData(10, 10))
    const atlas = new HostSpriteAtlasGPU(device, reg)
    atlas.sync()
    expect(counters.createTexture).toBe(1)

    // A later image (simulating map.graphics.addImage → markDirty) must
    // region-upload into the SAME texture, never recreate it.
    reg.addImage('b', new ImageData(20, 20))
    atlas.markDirty()
    atlas.sync()
    expect(counters.createTexture).toBe(1)
    expect(atlas.get('b')).toBeDefined()
  })

  it('getView caches per texture identity', () => {
    const { device, counters } = makeStubDevice()
    const atlas = new HostSpriteAtlasGPU(device, new HostImageRegistry())
    const v1 = atlas.getView()
    const v2 = atlas.getView()
    expect(v1).toBe(v2)
    expect(counters.createView).toBe(1)
  })

  it('reports a loaded state and resolves whenReady immediately', async () => {
    const { device } = makeStubDevice()
    const atlas = new HostSpriteAtlasGPU(device, new HostImageRegistry())
    expect(atlas.getState().status).toBe('loaded')
    await expect(atlas.whenReady()).resolves.toBeUndefined()
  })
})
