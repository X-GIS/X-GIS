// R4 (#1153 P2) — loadImageTexture (the WebGPU raster-tile decode path) leaked
// the decoded ImageBitmap on its failure branch: the catch returned null WITHOUT
// closing it. This pins that cleanup. The half-created GPUTexture is deliberately
// NOT destroyed here — createTexture/copyExternalImageToTexture throw only on a
// lost/OOM device, where device teardown reclaims it, and a raw texture.destroy()
// would grow @xgis/data's GPU footprint against the #997 shrink-only ratchet.
//
// loadImageTexture calls the module-local loadImageBitmap (safeFetch + the
// createImageBitmap global). A vi.mock('@xgis/shared') binds too late here (the
// data barrel is eagerly loaded by the projection setup), so — like the SSRF
// integration test — we stub the GLOBAL fetch (safeFetch's transport) and
// createImageBitmap, with a PUBLIC host that passes the SSRF literal check.

import { describe, it, expect, vi, afterEach } from 'vitest'

// WebGPU int-enum global the loadImageTexture usage-flag expression reads
// (`GPUTextureUsage.TEXTURE_BINDING | …`) — absent in the node test env, so
// polyfill it (values mirror the spec / webgpu-stub) before importing the SUT.
;(globalThis as unknown as { GPUTextureUsage?: Record<string, number> }).GPUTextureUsage ??= {
  COPY_SRC: 1,
  COPY_DST: 2,
  TEXTURE_BINDING: 4,
  STORAGE_BINDING: 8,
  RENDER_ATTACHMENT: 16,
}

import { loadImageTexture } from './tile-select'

const priorFetch = globalThis.fetch
const priorCIB = (globalThis as { createImageBitmap?: unknown }).createImageBitmap

afterEach(() => {
  vi.restoreAllMocks()
  globalThis.fetch = priorFetch
  ;(globalThis as { createImageBitmap?: unknown }).createImageBitmap = priorCIB
})

function installFakeBitmap(): { close: ReturnType<typeof vi.fn> } {
  const close = vi.fn()
  globalThis.fetch = (async () => new Response('tile-bytes', { status: 200 })) as typeof fetch
  ;(globalThis as { createImageBitmap?: unknown }).createImageBitmap = async () => ({
    width: 4,
    height: 4,
    close,
  })
  return { close }
}

const URL = 'https://example.com/tile.png' // public → passes the SSRF literal check

describe('loadImageTexture failure cleanup (#1153 P2 R4 — WebGPU twin)', () => {
  it('closes the bitmap when the upload throws (texture reclaimed by device teardown)', async () => {
    const { close } = installFakeBitmap()
    const destroy = vi.fn()
    const device = {
      createTexture: vi.fn(() => ({ destroy })),
      queue: {
        copyExternalImageToTexture: vi.fn(() => {
          throw new Error('device lost mid-upload')
        }),
      },
    } as unknown as GPUDevice

    const tex = await loadImageTexture(device, URL)

    expect(tex).toBeNull() // WebGPU null contract preserved
    // Fail-before: the old catch returned null leaking the bitmap.
    expect(close).toHaveBeenCalledTimes(1) // bitmap released
    // The texture is NOT destroyed here (see file header — #997 keeps data GPU-lean).
    expect(destroy).not.toHaveBeenCalled()
  })

  it('closes the bitmap when createTexture itself throws (no texture to destroy)', async () => {
    const { close } = installFakeBitmap()
    const device = {
      createTexture: vi.fn(() => {
        throw new Error('createTexture failed on lost device')
      }),
      queue: { copyExternalImageToTexture: vi.fn() },
    } as unknown as GPUDevice

    const tex = await loadImageTexture(device, URL)

    expect(tex).toBeNull()
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('does not leak on the happy path (bitmap closed once, texture returned)', async () => {
    const { close } = installFakeBitmap()
    const texture = { destroy: vi.fn() }
    const device = {
      createTexture: vi.fn(() => texture),
      queue: { copyExternalImageToTexture: vi.fn() },
    } as unknown as GPUDevice

    const tex = await loadImageTexture(device, URL)

    expect(tex).toBe(texture)
    expect(close).toHaveBeenCalledTimes(1)
    expect(texture.destroy).not.toHaveBeenCalled()
  })
})
