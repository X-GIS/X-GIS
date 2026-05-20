// Pin iter-198 dead-source drop. LLVM-style early DCE: a source
// declared in `style.sources` that no layer references gets warned
// and skipped from emit. Saves a tile-fetch round trip + IR slot.
//
// Real-world trigger: OFM Bright fixture declares `ne2_shaded` (NE2
// shaded relief raster) that no layer references — relic of an older
// hillshade approach. Without this pass the converter emitted the
// `source ne2_shaded { type: raster ... }` block and the runtime
// prewarm path probed the tile URL on init.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('iter-198 dead-source drop', () => {
  it('drops unreferenced source + warns', () => {
    const style = {
      version: 8,
      sources: {
        used: { type: 'vector', url: 'https://example.com/used.json' },
        unused: { type: 'raster', url: 'https://example.com/unused.json' },
      },
      layers: [
        { id: 'l1', type: 'fill', source: 'used', 'source-layer': 'foo', paint: { 'fill-color': '#000' } },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('source used')
    expect(code).not.toMatch(/^source unused\s+\{/m)
    expect(code).toMatch(/Source "unused" .* is declared but never referenced/)
  })

  it('retains every source when style has zero layers (fixture-only path)', () => {
    // A sources-only style is the unit-test fixture pattern. The drop
    // pass shouldn't trigger there — every source legitimately exists
    // to be tested in isolation. Pinned to keep the convertSource
    // suite intact.
    const style = {
      version: 8,
      sources: {
        a: { type: 'vector', url: 'https://x/a.json' },
        b: { type: 'raster', tiles: ['https://x/b/{z}/{x}/{y}.png'] },
      },
      layers: [],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('source a')
    expect(code).toContain('source b')
    expect(code).not.toMatch(/declared but never referenced/)
  })

  it('mixed: keep referenced, drop unreferenced', () => {
    const style = {
      version: 8,
      sources: {
        a: { type: 'vector', url: 'https://x/a.json' },
        b: { type: 'vector', url: 'https://x/b.json' },
        c: { type: 'raster', tiles: ['https://x/c/{z}/{x}/{y}.png'] },
      },
      layers: [
        { id: 'la', type: 'fill', source: 'a', 'source-layer': 'foo', paint: { 'fill-color': '#000' } },
        { id: 'lc', type: 'raster', source: 'c' },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('source a')
    expect(code).toContain('source c')
    expect(code).not.toMatch(/^source b\s+\{/m)
    expect(code).toMatch(/Source "b" .* is declared but never referenced/)
  })

  it('background-only layer set still drops unused sources', () => {
    // Background layers don't carry `source`, so a sources block with
    // a background-only layer set has every source unused. The drop
    // still applies.
    const style = {
      version: 8,
      sources: {
        unused: { type: 'vector', url: 'https://x/u.json' },
      },
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': '#fff' } },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toMatch(/^source unused\s+\{/m)
    expect(code).toMatch(/Source "unused" .* is declared but never referenced/)
  })
})
