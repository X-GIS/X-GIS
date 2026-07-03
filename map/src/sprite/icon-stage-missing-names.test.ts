// Pin iter 526 missing-icon-names diagnostic. The IconStage silently
// drops icons whose name isn't in the atlas at prepare()-time. This
// is correct end-user behaviour (no console flood, no fallback
// rendering) but obscures the iter-510 baseline finding that
// MapLibre's `school` marker and X-GIS' atlas resolution diverge:
// styles reference `school`; the OFM Bright atlas only has
// `school_11`. The diagnostic surfaces THAT divergence by recording
// every missing name AFTER the atlas reaches its terminal 'loaded'
// state.
//
// The host-loading state can't be exercised without a full WebGPU
// device, so this test uses the SpriteAtlasHost in test mode via
// the same stub pattern as sprite-atlas-host.test.ts and only
// exercises the stage's tracking logic via a thin shim.

import { describe, it, expect, beforeEach } from 'vitest'
import { SpriteAtlasHost } from './sprite-atlas-host'

// Minimal IconStage-like shim that mirrors the iter 526 contract:
// missingIconNames records lookups that miss WHEN the host status is
// 'loaded', and stays silent during loading/idle/failed.
class IconStageProbe {
  private missingIconNames: Set<string> = new Set()
  constructor(private host: SpriteAtlasHost) {}
  probe(name: string): boolean {
    const sprite = this.host.get(name)
    if (!sprite) {
      if (this.host.getState().status === 'loaded') this.missingIconNames.add(name)
      return false
    }
    return true
  }
  getMissingIconNames(): string[] {
    return [...this.missingIconNames].sort()
  }
  clearMissingIconNames(): void {
    this.missingIconNames.clear()
  }
}

const FIXTURE_JSON = {
  airport_11: { x: 0, y: 0, width: 24, height: 24, pixelRatio: 1 },
  school_11: { x: 30, y: 0, width: 24, height: 24, pixelRatio: 1 },
}

const TINY_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47])

function installImageBitmapStub(): () => void {
  const original = (globalThis as { createImageBitmap?: unknown }).createImageBitmap
  ;(globalThis as { createImageBitmap?: unknown }).createImageBitmap = async () => {
    return { width: 64, height: 64, close: () => {} } as unknown as ImageBitmap
  }
  return () => {
    ;(globalThis as { createImageBitmap?: unknown }).createImageBitmap = original
  }
}

function makeFetch(): typeof globalThis.fetch {
  return ((input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('.json')) {
      return Promise.resolve(
        new Response(JSON.stringify(FIXTURE_JSON), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
    }
    return Promise.resolve(
      new Response(TINY_PNG, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }),
    )
  }) as typeof globalThis.fetch
}

describe('IconStage missing-icon-names diagnostic (iter 526)', () => {
  let restoreStub: () => void
  beforeEach(() => {
    restoreStub = installImageBitmapStub()
  })

  it('does NOT record misses BEFORE atlas loads (loading-state false positives)', async () => {
    const host = new SpriteAtlasHost({ spriteUrl: 'http://x/atlas', fetch: makeFetch() })
    const probe = new IconStageProbe(host)
    // host.ensure() hasn't been called → state is 'idle'. Probe
    // misses but missingIconNames stays empty.
    expect(probe.probe('school')).toBe(false)
    expect(probe.probe('hospital')).toBe(false)
    expect(probe.getMissingIconNames()).toEqual([])
    restoreStub()
  })

  it('records misses AFTER atlas loads (the real diagnostic path)', async () => {
    const host = new SpriteAtlasHost({ spriteUrl: 'http://x/atlas', fetch: makeFetch() })
    const probe = new IconStageProbe(host)
    await host.whenReady()
    expect(host.getState().status).toBe('loaded')

    // The iter-510 baseline mystery: style references `school`, atlas
    // only carries `school_11`. The lookup misses; diagnostic records.
    expect(probe.probe('school')).toBe(false)
    expect(probe.probe('hospital')).toBe(false)
    expect(probe.probe('school_11')).toBe(true) // exact match wins
    expect(probe.probe('airport_11')).toBe(true)
    expect(probe.getMissingIconNames()).toEqual(['hospital', 'school'])
    restoreStub()
  })

  it('clearMissingIconNames resets the set', async () => {
    const host = new SpriteAtlasHost({ spriteUrl: 'http://x/atlas', fetch: makeFetch() })
    const probe = new IconStageProbe(host)
    await host.whenReady()
    probe.probe('does_not_exist')
    expect(probe.getMissingIconNames()).toEqual(['does_not_exist'])
    probe.clearMissingIconNames()
    expect(probe.getMissingIconNames()).toEqual([])
    restoreStub()
  })

  it('repeated misses dedupe (set semantic)', async () => {
    const host = new SpriteAtlasHost({ spriteUrl: 'http://x/atlas', fetch: makeFetch() })
    const probe = new IconStageProbe(host)
    await host.whenReady()
    for (let i = 0; i < 100; i++) probe.probe('school')
    expect(probe.getMissingIconNames()).toEqual(['school'])
    restoreStub()
  })

  it('output is sorted (deterministic across runs)', async () => {
    const host = new SpriteAtlasHost({ spriteUrl: 'http://x/atlas', fetch: makeFetch() })
    const probe = new IconStageProbe(host)
    await host.whenReady()
    probe.probe('zzz')
    probe.probe('aaa')
    probe.probe('mmm')
    expect(probe.getMissingIconNames()).toEqual(['aaa', 'mmm', 'zzz'])
    restoreStub()
  })
})
