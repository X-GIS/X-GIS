// Regression test for first-arm-wins semantics on duplicate match keys.
// Mapbox `match` is first-arm-wins: if a value appears under two different
// output colours the FIRST one wins. Pre-fix the expander had no cross-arm
// dedup, so the duplicate value landed in TWO sublayer `["in", …]` filters
// and the feature was drawn twice — the LATER arm's colour won (wrong).

import { describe, it, expect } from 'vitest'
import { expandPerFeatureColorMatch } from '../convert/expand-color-match'
import type { MapboxLayer } from '../convert/types'

function buildLayer(matchArgs: unknown[]): MapboxLayer {
  return {
    id: 'l',
    type: 'fill',
    source: 'v',
    'source-layer': 'land',
    paint: {
      'fill-color': ['match', ['get', 'iso'], ...matchArgs] as never,
    },
  } as MapboxLayer
}

describe('expandPerFeatureColorMatch — duplicate key first-arm-wins', () => {
  it('duplicate key only appears under the FIRST colour sublayer', () => {
    // 'US' is listed under both '#abc' (first) and '#def' (second).
    // Mapbox semantics: 'US' → '#abc'. The expander must assign 'US'
    // only to the '#abc' sublayer and skip it in '#def'.
    const expanded = expandPerFeatureColorMatch(buildLayer([
      'US', '#abc',
      ['US', 'CA'], '#def',
      '#000',
    ]))

    expect(expanded).not.toBeNull()
    const sublayers = expanded!

    // Find sublayer for '#abc' and '#def'
    const abcLayer = sublayers.find(
      (l) => (l.paint as Record<string, unknown>)['fill-color'] === '#abc',
    )
    const defLayer = sublayers.find(
      (l) => (l.paint as Record<string, unknown>)['fill-color'] === '#def',
    )

    expect(abcLayer).toBeDefined()
    expect(defLayer).toBeDefined()

    // The '#abc' sublayer's in-filter must contain 'US'
    const abcFilter = abcLayer!.filter as unknown[]
    const abcInFilter = abcFilter[0] === 'all'
      ? (abcFilter as unknown[]).find((f): f is unknown[] => Array.isArray(f) && f[0] === 'in')
      : (abcFilter as unknown[])
    const abcVals: (string | number)[] = ((abcInFilter as unknown[])[2] as unknown[])[1] as (string | number)[]
    expect(abcVals).toContain('US')

    // The '#def' sublayer's in-filter must NOT contain 'US'
    const defFilter = defLayer!.filter as unknown[]
    const defInFilter = defFilter[0] === 'all'
      ? (defFilter as unknown[]).find((f): f is unknown[] => Array.isArray(f) && f[0] === 'in')
      : (defFilter as unknown[])
    const defVals: (string | number)[] = ((defInFilter as unknown[])[2] as unknown[])[1] as (string | number)[]
    expect(defVals).not.toContain('US')
  })

  it('duplicate key does NOT appear in allVals more than once (default NOT-IN filter)', () => {
    // 'US' appears under two arms. allVals should contain 'US' exactly once
    // so the NOT-IN default filter is minimal and correct.
    const expanded = expandPerFeatureColorMatch(buildLayer([
      'US', '#abc',
      ['US', 'CA'], '#def',
      '#000',
    ]))

    expect(expanded).not.toBeNull()
    const sublayers = expanded!

    // The last sublayer is the default (NOT-IN) arm
    const defaultLayer = sublayers[sublayers.length - 1]
    const defaultFilter = defaultLayer.filter as unknown[]
    // Structure: ['!', ['in', ['get', field], ['literal', allVals]]]
    // possibly wrapped in ['all', existingFilter, notIn]
    const notInExpr = defaultFilter[0] === 'all'
      ? (defaultFilter as unknown[]).find((f): f is unknown[] => Array.isArray(f) && f[0] === '!')
      : (defaultFilter as unknown[])
    const inExpr = (notInExpr as unknown[])[1] as unknown[]
    const allVals: (string | number)[] = ((inExpr as unknown[])[2] as unknown[])[1] as (string | number)[]

    const usCount = allVals.filter((v) => v === 'US').length
    expect(usCount).toBe(1)
  })
})
