import { describe, it, expect, afterEach } from 'vitest'
import { SpriteAtlasHost } from './sprite/sprite-atlas-host'
import { GlyphPbfCache } from './text/sdf/pbf/glyph-pbf-cache'
import { loadImageTexture } from '../data/tile-select'
import { VectorTileLoader } from '../loader/vector-tile-loader'

// Integration: the SSRF guard must DEGRADE gracefully (state 'failed',
// no fetch issued) for a private/loopback or dangerous asset URL —
// matching the existing offline/404 fallback, never crashing the caller.

function spyFetch(): { fn: typeof globalThis.fetch; calls: () => number } {
  let calls = 0
  const fn = (async () => {
    calls += 1
    return new Response('', { status: 200 })
  }) as unknown as typeof globalThis.fetch
  return { fn, calls: () => calls }
}

// Some wired sites (loadImageTexture, the vector-tile loader, the PMTiles
// lib) call the GLOBAL fetch — patch it so an SSRF-blocked URL provably
// never reaches the network.
function patchGlobalFetch(): { calls: () => number; restore: () => void } {
  let calls = 0
  const original = globalThis.fetch
  globalThis.fetch = (async () => {
    calls += 1
    return new Response('', { status: 200 })
  }) as unknown as typeof globalThis.fetch
  return { calls: () => calls, restore: () => { globalThis.fetch = original } }
}

describe('SSRF guard — sprite atlas', () => {
  it('degrades a private-host sprite URL to failed without fetching', async () => {
    const spy = spyFetch()
    const host = new SpriteAtlasHost({ spriteUrl: 'http://127.0.0.1/atlas', fetch: spy.fn })
    await host.whenReady()
    expect(host.getState().status).toBe('failed')
    expect(spy.calls()).toBe(0)
  })

  it('still loads a public sprite URL (guard does not over-block)', () => {
    const spy = spyFetch()
    const host = new SpriteAtlasHost({ spriteUrl: 'https://example.com/sprites/foo', fetch: spy.fn })
    // Public URL passes the guard → a fetch is attempted.
    expect(spy.calls()).toBeGreaterThan(0)
    expect(host.getState().status).not.toBe('failed')
  })
})

describe('SSRF guard — glyph cache', () => {
  it('degrades a private-host glyph URL to failed without fetching', () => {
    const spy = spyFetch()
    const cache = new GlyphPbfCache({
      glyphsUrl: 'http://192.168.0.1/font/{fontstack}/{range}.pbf',
      fetch: spy.fn,
    })
    let ready = false
    cache.ensure('Open Sans', 65, () => { ready = true })
    expect(spy.calls()).toBe(0)
    expect(ready).toBe(false)
    expect(cache.get('Open Sans', 65)).toBeUndefined()
  })

  it('still fetches a public glyph URL (guard does not over-block)', () => {
    const spy = spyFetch()
    const cache = new GlyphPbfCache({
      glyphsUrl: 'https://example.com/font/{fontstack}/{range}.pbf',
      fetch: spy.fn,
    })
    cache.ensure('Open Sans', 65, () => {})
    expect(spy.calls()).toBeGreaterThan(0)
  })
})

describe('SSRF guard — raster image tile (loadImageTexture)', () => {
  let patch: ReturnType<typeof patchGlobalFetch>
  afterEach(() => patch?.restore())

  // A dummy device — the guard returns null BEFORE the device is touched,
  // so the cast never gets exercised on the blocked path.
  const fakeDevice = {} as unknown as GPUDevice

  it('returns null for a cloud-metadata raster URL without fetching', async () => {
    patch = patchGlobalFetch()
    const tex = await loadImageTexture(fakeDevice, 'http://169.254.169.254/latest/meta-data')
    expect(tex).toBeNull()
    expect(patch.calls()).toBe(0)
  })

  it('returns null for a file: raster URL without fetching', async () => {
    patch = patchGlobalFetch()
    const tex = await loadImageTexture(fakeDevice, 'file:///etc/passwd')
    expect(tex).toBeNull()
    expect(patch.calls()).toBe(0)
  })

  it('attempts a fetch for a normal https raster URL (guard does not over-block)', async () => {
    patch = patchGlobalFetch()
    // The stub fetch returns an empty 200; createImageBitmap then fails and
    // the fn returns null — but the fetch HAVING been issued proves the
    // public URL passed the guard.
    await loadImageTexture(fakeDevice, 'https://tiles.example.com/0/0/0.png').catch(() => null)
    expect(patch.calls()).toBeGreaterThan(0)
  })
})

describe('SSRF guard — vector-tile loader (PMTiles + TileJSON)', () => {
  let patch: ReturnType<typeof patchGlobalFetch>
  afterEach(() => patch?.restore())

  it('rejects a private-host PMTiles archive URL without fetching', async () => {
    patch = patchGlobalFetch()
    const loader = new VectorTileLoader()
    await expect(loader.openArchive('https://10.0.0.5/data.pmtiles')).rejects.toThrow()
    expect(patch.calls()).toBe(0)
  })

  it('rejects a private-host TileJSON URL without fetching', async () => {
    patch = patchGlobalFetch()
    const loader = new VectorTileLoader()
    // Use a non-template URL so it takes the real fetch path (a {z}/{x}/{y}
    // template short-circuits to a synthetic in-memory manifest).
    await expect(loader.openTileJSON('https://127.0.0.1/tiles.json')).rejects.toThrow()
    expect(patch.calls()).toBe(0)
  })

  it('does not block a normal https TileJSON URL at the guard (fetch is attempted)', async () => {
    patch = patchGlobalFetch()
    const loader = new VectorTileLoader()
    // Public host passes the guard → the loader proceeds to fetch (the stub
    // 200 has no tiles[] so parsing fails afterwards — but the guard let it
    // through, which is what we assert here).
    await loader.openTileJSON('https://tiles.example.com/manifest.json').catch(() => null)
    expect(patch.calls()).toBeGreaterThan(0)
  })
})
