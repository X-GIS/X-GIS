import { describe, it, expect } from 'vitest'
import { SpriteAtlasHost } from './sprite/sprite-atlas-host'
import { GlyphPbfCache } from './text/sdf/pbf/glyph-pbf-cache'

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
