import { describe, it, expect } from 'vitest'
import { SpriteAtlasHost } from './sprite-atlas-host'

// Mock fetch that returns a fixture JSON + a tiny 1x1 PNG. We don't
// test the PNG decode path here — that requires a browser-like image
// decoder which vitest doesn't ship. Instead we stub `createImageBitmap`
// to short-circuit to a known object, focusing the test on metadata
// parsing, URL building, and state transitions.

const FIXTURE_JSON = {
  aerialway: { x: 147, y: 190, width: 19, height: 19, pixelRatio: 1 },
  airport:   { x: 100, y: 100, width: 24, height: 24, pixelRatio: 2 },
  pin_sdf:   { x: 0, y: 0, width: 16, height: 16, sdf: true },
  malformed: { x: 0 },  // missing y/width/height — should be dropped
}

const TINY_PNG = new Uint8Array([
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,  // PNG signature
  0x00, 0x00, 0x00, 0x0D,                          // IHDR length
])

function installImageBitmapStub(): { restore: () => void; created: number } {
  const original = (globalThis as { createImageBitmap?: unknown }).createImageBitmap
  let created = 0
  ;(globalThis as { createImageBitmap?: unknown }).createImageBitmap = async () => {
    created += 1
    return { width: 256, height: 256, close: () => {} } as unknown as ImageBitmap
  }
  return {
    restore: () => { (globalThis as { createImageBitmap?: unknown }).createImageBitmap = original },
    get created() { return created },
  }
}

function makeFetch(urls: string[], opts: {
  jsonOk?: boolean; pngOk?: boolean; suffix2xOk?: boolean
} = {}): typeof globalThis.fetch {
  const { jsonOk = true, pngOk = true, suffix2xOk = true } = opts
  return ((input: RequestInfo | URL) => {
    const url = String(input)
    urls.push(url)
    const is2x = url.includes('@2x')
    const isJson = url.endsWith('.json')
    if (is2x && !suffix2xOk) {
      return Promise.resolve(new Response('', { status: 404 }))
    }
    if (isJson) {
      return Promise.resolve(new Response(JSON.stringify(FIXTURE_JSON), {
        status: jsonOk ? 200 : 404,
        headers: { 'content-type': 'application/json' },
      }))
    }
    return Promise.resolve(new Response(TINY_PNG, {
      status: pngOk ? 200 : 404,
      headers: { 'content-type': 'image/png' },
    }))
  }) as typeof globalThis.fetch
}

describe('SpriteAtlasHost', () => {
  it('fetches sprite.json + sprite.png at 1x by default', async () => {
    const urls: string[] = []
    const stub = installImageBitmapStub()
    const host = new SpriteAtlasHost({
      spriteUrl: 'https://example.com/sprites/foo',
      fetch: makeFetch(urls),
    })
    await host.whenReady()
    stub.restore()

    expect(urls).toHaveLength(2)
    expect(urls.some(u => u.endsWith('/foo.json'))).toBe(true)
    expect(urls.some(u => u.endsWith('/foo.png'))).toBe(true)
    expect(host.getState().status).toBe('loaded')
  })

  it('tries @2x first on high-DPR, falls back to 1x on 404', async () => {
    const urls: string[] = []
    const stub = installImageBitmapStub()
    const host = new SpriteAtlasHost({
      spriteUrl: 'https://example.com/sprites/foo',
      fetch: makeFetch(urls, { suffix2xOk: false }),
      dpr: 2,
    })
    await host.whenReady()
    stub.restore()

    expect(host.getState().status).toBe('loaded')
    expect(urls.some(u => u.includes('@2x'))).toBe(true)
    expect(urls.some(u => u.endsWith('/foo.json'))).toBe(true)  // 1x fallback
  })

  it('parses metadata + drops malformed entries', async () => {
    const urls: string[] = []
    const stub = installImageBitmapStub()
    const host = new SpriteAtlasHost({
      spriteUrl: 'https://example.com/sprites/foo',
      fetch: makeFetch(urls),
    })
    await host.whenReady()
    stub.restore()

    expect(host.get('aerialway')).toEqual({
      name: 'aerialway', x: 147, y: 190, width: 19, height: 19,
      pixelRatio: 1, sdf: false,
    })
    expect(host.get('airport')!.pixelRatio).toBe(2)
    expect(host.get('pin_sdf')!.sdf).toBe(true)
    expect(host.get('malformed')).toBeUndefined()
    expect(host.get('does_not_exist')).toBeUndefined()
  })

  it('transitions to failed on JSON 404 — silent, no throw', async () => {
    const urls: string[] = []
    const stub = installImageBitmapStub()
    const host = new SpriteAtlasHost({
      spriteUrl: 'https://example.com/sprites/foo',
      fetch: makeFetch(urls, { jsonOk: false }),
    })
    await host.whenReady()
    stub.restore()

    expect(host.getState().status).toBe('failed')
    expect(host.get('aerialway')).toBeUndefined()
  })

  it('transitions to failed on PNG 404 — even when JSON is good', async () => {
    const urls: string[] = []
    const stub = installImageBitmapStub()
    const host = new SpriteAtlasHost({
      spriteUrl: 'https://example.com/sprites/foo',
      fetch: makeFetch(urls, { pngOk: false }),
    })
    await host.whenReady()
    stub.restore()

    expect(host.getState().status).toBe('failed')
  })

  it('whenReady resolves on both terminal states', async () => {
    const stub = installImageBitmapStub()
    const failed = new SpriteAtlasHost({
      spriteUrl: 'https://x/y',
      fetch: makeFetch([], { jsonOk: false }),
    })
    const loaded = new SpriteAtlasHost({
      spriteUrl: 'https://x/y',
      fetch: makeFetch([]),
    })
    await Promise.all([failed.whenReady(), loaded.whenReady()])
    stub.restore()
    expect(failed.getState().status).toBe('failed')
    expect(loaded.getState().status).toBe('loaded')
  })
})
