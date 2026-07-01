import { describe, it, expect, afterEach } from 'vitest'
import { SpriteAtlasHost } from '@xgis/map'
import { GlyphPbfCache } from './text/sdf/pbf/glyph-pbf-cache'
import { loadImageTexture } from '@xgis/data'
import { VectorTileLoader } from '@xgis/data'

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

// Mock fetch that models the redirect-SSRF: a public host answers the FIRST
// request with a 302 whose `Location` points at a private/loopback address.
// It honours fetch redirect semantics so it discriminates the FIX from the
// bug: with the default `redirect:'follow'` (the un-fixed code path) it
// transparently follows the 302 and serves the PRIVATE host's 200 body — the
// SSRF. With `redirect:'manual'` (what safeFetch passes) it returns the raw
// 302, leaving safeFetch to re-validate + refuse the Location. `urls` records
// every URL actually requested so a test can assert the private host was hit
// (bug) or never reached (fixed).
function redirectingFetch(redirectTo: string): {
  fn: typeof globalThis.fetch
  urls: string[]
} {
  const urls: string[] = []
  let first = true
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    urls.push(url)
    if (first) {
      first = false
      const manual = init?.redirect === 'manual'
      if (manual) {
        return new Response('', { status: 302, headers: { location: redirectTo } })
      }
      // Default redirect:'follow' → transparently follow to the private host
      // and hand back ITS body (the SSRF the fix must prevent).
      urls.push(redirectTo)
      return new Response('', { status: 200 })
    }
    return new Response('', { status: 200 })
  }) as unknown as typeof globalThis.fetch
  return { fn, urls }
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

  it('fails (never fetches the private host) when a public sprite URL 302s to cloud metadata', async () => {
    const r = redirectingFetch('http://169.254.169.254/latest/meta-data')
    const host = new SpriteAtlasHost({ spriteUrl: 'https://example.com/sprites/foo', fetch: r.fn })
    await host.whenReady()
    expect(host.getState().status).toBe('failed')
    // The first-hop public URL was fetched, but the redirect target —
    // re-validated by safeFetch — was refused before reaching the network.
    expect(r.urls.some(u => u.includes('169.254.169.254'))).toBe(false)
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

  it('marks the range failed (never fetches the private host) when a public glyph URL 302s to a loopback address', async () => {
    const r = redirectingFetch('http://127.0.0.1/font/Open%20Sans/0-255.pbf')
    const cache = new GlyphPbfCache({
      glyphsUrl: 'https://example.com/font/{fontstack}/{range}.pbf',
      fetch: r.fn,
    })
    let ready = false
    cache.ensure('Open Sans', 65, () => { ready = true })
    // safeFetch rejects on the re-validated redirect → range degrades to the
    // silent 'failed' fallback. The rejection threads through an async fetch
    // + .then/.catch chain, so let the microtask queue drain until the range
    // settles (bounded so a real hang fails the test rather than loops).
    for (let i = 0; i < 50 && !cache.isResolved('Open Sans', 65); i++) {
      await Promise.resolve()
    }
    expect(ready).toBe(false)
    expect(cache.get('Open Sans', 65)).toBeUndefined()
    expect(cache.isResolved('Open Sans', 65)).toBe(true)
    expect(r.urls.some(u => u.includes('127.0.0.1'))).toBe(false)
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
