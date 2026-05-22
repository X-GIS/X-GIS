// iter-326 — END-TO-END reproduction of the user-reported OFM Bright
// Seoul bilingual label scene, through the REAL converter + parser +
// evaluator (no synthetic strings). Pins the exact text-field the
// runtime \n-skip fix (iter-325, runtime bilingual-label-placement-
// repro.test.ts) consumes, and proves Seoul is labelled by exactly ONE
// layer at the reported zoom (so the ghost was NOT a cross-layer
// duplicate — it was the unpositioned \n glyph).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { exprToXgis } from '../convert/expressions'
import { parseExpressionString } from '../parser/parser'
import { evaluate } from '../eval/evaluator'

interface MbLayer {
  id: string
  type?: string
  'source-layer'?: string
  minzoom?: number
  maxzoom?: number
  filter?: unknown
  layout?: Record<string, unknown>
}

const HERE = dirname(fileURLToPath(import.meta.url))
const bright = JSON.parse(
  readFileSync(join(HERE, 'fixtures', 'openfreemap-bright.json'), 'utf8'),
) as { layers: MbLayer[] }
const LAYERS = bright.layers

// The user's feature: Seoul, a NATIONAL CAPITAL (capital=2) city with
// a non-Latin name. #8.60/37.35270/126.59795.
const SEOUL = {
  class: 'city', capital: 2, rank: 1,
  'name:latin': 'Seoul', 'name:nonlatin': '서울특별시',
  name: '서울특별시', name_en: 'Seoul',
}

/** Convert a Mapbox expression to xgis, parse, evaluate against props. */
function evalMapbox(mb: unknown, props: Record<string, unknown>): unknown {
  const xg = exprToXgis(mb, [])
  if (xg === null) throw new Error('exprToXgis returned null')
  return evaluate(parseExpressionString(xg), props)
}

const Z = 8.6  // user's zoom

describe('iter-326 OFM Bright Seoul — end-to-end via real converter', () => {
  const placeSymbol = LAYERS.filter(l => l['source-layer'] === 'place' && l.type === 'symbol')

  it('place symbol layers exist (sanity)', () => {
    expect(placeSymbol.length).toBeGreaterThan(0)
    expect(placeSymbol.map(l => l.id)).toContain('label_city_capital')
  })

  it('Seoul matches EXACTLY ONE place layer at z=8.6 (no cross-layer duplicate)', () => {
    // Evaluate each layer's REAL filter + zoom window for Seoul.
    const matched: string[] = []
    for (const l of placeSymbol) {
      // Zoom window.
      if (l.minzoom !== undefined && Z < l.minzoom) continue
      if (l.maxzoom !== undefined && Z >= l.maxzoom) continue
      // Filter (undefined filter = always true).
      const pass = l.filter === undefined ? true : evalMapbox(l.filter, SEOUL) === true
      if (pass) matched.push(l.id)
    }
    // The ghost was NOT two layers labelling Seoul — it's one layer.
    expect(matched, `expected only label_city_capital, got ${JSON.stringify(matched)}`)
      .toEqual(['label_city_capital'])
  })

  it('label_other does NOT match a city (inverted match — common misread)', () => {
    // ["match",["get","class"],["city",...],false,true] → class in list
    // returns the MATCH value (false), default is true. So named place
    // classes are EXCLUDED from label_other. Pin this so a future
    // converter change to match-inversion is caught.
    const other = placeSymbol.find(l => l.id === 'label_other')!
    expect(evalMapbox(other.filter, SEOUL)).toBe(false)
    // A class NOT in the list (e.g. suburb) → label_other DOES match.
    expect(evalMapbox(other.filter, { ...SEOUL, class: 'suburb' })).toBe(true)
  })

  it('text-field resolves to the bilingual "Seoul\\n서울특별시" (literal newline)', () => {
    const layer = placeSymbol.find(l => l.id === 'label_city_capital')!
    const resolved = evalMapbox(layer.layout!['text-field'], SEOUL)
    expect(resolved).toBe('Seoul\n서울특별시')
    // The literal \n is what wrapWithKnuthPlass splits on → the line
    // the runtime \n-skip fix (iter-325) handles. Cross-ref:
    // runtime/src/engine/text/bilingual-label-placement-repro.test.ts.
    expect(String(resolved)).toContain('\n')
  })

  it('non-capital city (capital≠2) takes label_city, capital takes label_city_capital', () => {
    // Confirms the capital split — both use the SAME bilingual text-field,
    // so a non-capital bilingual city hits the identical \n path.
    const busan = { ...SEOUL, capital: 0, 'name:latin': 'Busan', 'name:nonlatin': '부산광역시', name: '부산광역시' }
    const cityLayer = placeSymbol.find(l => l.id === 'label_city')!
    expect(evalMapbox(cityLayer.filter, busan)).toBe(true)
    expect(evalMapbox(cityLayer.filter, SEOUL)).toBe(false)  // Seoul is capital
    const resolved = evalMapbox(cityLayer.layout!['text-field'], busan)
    expect(resolved).toBe('Busan\n부산광역시')
  })

  it('Latin-only feature takes the coalesce branch (no newline, no \\n bug)', () => {
    // A place with no name:nonlatin → name_en / name, single line, no \n.
    const layer = placeSymbol.find(l => l.id === 'label_city_capital')!
    const paris = { class: 'city', capital: 2, name_en: 'Paris', name: 'Paris' }
    const resolved = evalMapbox(layer.layout!['text-field'], paris)
    expect(resolved).toBe('Paris')
    expect(String(resolved)).not.toContain('\n')
  })
})
