import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GlyphPbfCache } from './glyph-pbf-cache'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(HERE, '__fixtures__', 'open-sans-semibold-0-255.pbf')
const PBF_BYTES = readFileSync(FIXTURE)

/** Mock fetch: records URLs, returns the same fixture for any request. */
function mockFetchOK(urls: string[]): typeof globalThis.fetch {
  return (input: RequestInfo | URL): Promise<Response> => {
    urls.push(typeof input === 'string' ? input : input.toString())
    return Promise.resolve(new Response(PBF_BYTES, { status: 200 }))
  }
}

function mockFetchFail(urls: string[]): typeof globalThis.fetch {
  return (input: RequestInfo | URL): Promise<Response> => {
    urls.push(typeof input === 'string' ? input : input.toString())
    return Promise.resolve(new Response('', { status: 404 }))
  }
}

const URL_TEMPLATE = 'https://example.com/font/{fontstack}/{range}.pbf'

describe('GlyphPbfCache', () => {
  it('substitutes URL template tokens correctly', async () => {
    const urls: string[] = []
    const cache = new GlyphPbfCache({ glyphsUrl: URL_TEMPLATE, fetch: mockFetchOK(urls) })
    await new Promise<void>(resolve => {
      cache.ensureRange('Open Sans Semibold', 0x41, resolve)
    })
    expect(urls).toHaveLength(1)
    // Spaces get %20 encoded.
    expect(urls[0]).toBe('https://example.com/font/Open%20Sans%20Semibold/0-255.pbf')
  })

  it('hits cache and serves get() synchronously after load', async () => {
    const urls: string[] = []
    const cache = new GlyphPbfCache({ glyphsUrl: URL_TEMPLATE, fetch: mockFetchOK(urls) })
    await new Promise<void>(resolve => cache.ensureRange('Open Sans Semibold', 0x41, resolve))
    const g = cache.get('Open Sans Semibold', 0x41)
    expect(g).toBeDefined()
    expect(g!.id).toBe(0x41)
  })

  it('dedupes concurrent ensureRange calls into one fetch', async () => {
    const urls: string[] = []
    const cache = new GlyphPbfCache({ glyphsUrl: URL_TEMPLATE, fetch: mockFetchOK(urls) })
    let count = 0
    const wait = new Promise<void>(resolve => {
      const tick = () => { count += 1; if (count === 3) resolve() }
      cache.ensureRange('Open Sans Semibold', 0x41, tick)
      cache.ensureRange('Open Sans Semibold', 0x42, tick)
      cache.ensureRange('Open Sans Semibold', 0x43, tick)
    })
    await wait
    expect(urls).toHaveLength(1)
    expect(count).toBe(3)
  })

  it('marks failed ranges silently — subsequent calls do nothing', async () => {
    const urls: string[] = []
    const cache = new GlyphPbfCache({ glyphsUrl: URL_TEMPLATE, fetch: mockFetchFail(urls) })
    let called = 0
    await new Promise<void>(resolve => {
      cache.ensureRange('X', 0x41, () => { called += 1; resolve() })
      // Failures resolve via the promise's catch path; we wait via a
      // microtask race.
      queueMicrotask(() => queueMicrotask(() => queueMicrotask(resolve)))
    })
    // After settling, the failed-range second call should NOT issue a
    // fetch nor invoke the callback.
    let secondCalled = false
    cache.ensureRange('X', 0x41, () => { secondCalled = true })
    expect(urls).toHaveLength(1)  // only the first attempt
    expect(secondCalled).toBe(false)
    expect(called).toBe(0)        // failure → silent (callback not fired)
  })

  it('isResolved returns true for loaded and failed, false for loading and pristine', async () => {
    const cache = new GlyphPbfCache({ glyphsUrl: URL_TEMPLATE, fetch: mockFetchOK([]) })
    expect(cache.isResolved('X', 0x41)).toBe(false)  // pristine
    cache.ensureRange('X', 0x41, () => {})
    expect(cache.isResolved('X', 0x41)).toBe(false)  // still loading
    await new Promise<void>(resolve => cache.ensureRange('X', 0x42, resolve))
    expect(cache.isResolved('X', 0x41)).toBe(true)   // loaded
  })

  it('separates ranges by 256-codepoint boundary', async () => {
    const urls: string[] = []
    const cache = new GlyphPbfCache({ glyphsUrl: URL_TEMPLATE, fetch: mockFetchOK(urls) })
    await new Promise<void>(resolve => cache.ensureRange('X', 0x41, resolve))
    // Codepoint 0x141 is in range 256-511 — different range, new fetch.
    let secondFired = false
    await new Promise<void>(resolve => cache.ensureRange('X', 0x141, () => {
      secondFired = true; resolve()
    }))
    expect(secondFired).toBe(true)
    expect(urls).toHaveLength(2)
    expect(urls[0]).toContain('/0-255.pbf')
    expect(urls[1]).toContain('/256-511.pbf')
  })
})
