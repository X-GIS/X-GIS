// #2476 — Mapbox Style Spec v3 `slot` names a position inside an IMPORTED
// style's layer stack (`bottom` / `middle` / `top` in the Standard style).
// The converter emits every import ahead of the root style's own layers
// (`style-imports.ts`), so a slotted layer draws above the whole import instead
// of inside it — silently, the moment `imports` resolve (#2471). Until the
// interleave is designed, the converter must say so per layer. Control arms
// keep the warning honest: a
// slot on a style with no imports is moot and must NOT warn, and a layer with
// no slot must not either.

import { describe, expect, it } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

function convert(style: Record<string, unknown>): string[] {
  const warnings: string[] = []
  convertMapboxStyle(style as never, { coverage: { sources: [], layers: [], warnings } })
  return warnings
}

const layer = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: 'line',
  source: 's',
  'source-layer': 'road',
  ...extra,
})
const base = {
  version: 8,
  sources: { s: { type: 'vector', url: 'https://example.com/tiles.json' } },
}
const IMPORTS = [{ id: 'basemap', url: 'https://example.com/standard.json' }]

describe('#2476 — a slotted layer on a style with imports warns per layer', () => {
  it('imports + slot: one warning naming the layer AND the slot, saying the layer draws above the import', () => {
    const w = convert({ ...base, imports: IMPORTS, layers: [layer('roads', { slot: 'middle' })] })
    const hits = w.filter((m) => m.includes('slot'))
    expect(hits.length).toBe(1)
    expect(hits[0]).toContain('"roads"')
    expect(hits[0]).toContain('"middle"')
    expect(hits[0]).toMatch(/above/i)
  })

  it('two slotted layers warn once each (per layer, not once per style)', () => {
    const w = convert({
      ...base,
      imports: IMPORTS,
      layers: [layer('a', { slot: 'bottom' }), layer('b', { slot: 'top' }), layer('c')],
    })
    expect(w.filter((m) => m.includes('slot')).length).toBe(2)
  })

  it('control: a slot on a style with NO imports is moot and does not warn', () => {
    const w = convert({ ...base, layers: [layer('roads', { slot: 'middle' })] })
    expect(w.some((m) => m.includes('slot'))).toBe(false)
  })

  it('control: imports without any slotted layer do not warn about slots', () => {
    const w = convert({ ...base, imports: IMPORTS, layers: [layer('roads')] })
    expect(w.some((m) => m.includes('slot'))).toBe(false)
  })
})
