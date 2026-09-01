// Mapbox layout.symbol-sort-key, EXPRESSION form → LabelDef.sortKeyExpr (#2166).
//
// The constant form has been plumbed end-to-end since iter 399-405; the
// expression form was thrown away at the converter with a "flattened to 0"
// warning that was not even accurate — MEASURED on the pre-#2166 tree,
// `["get","rank"]` emitted NO `label-sort-key` utility at all, leaving `sortKey`
// undefined for the collision pass to read as `?? 0`.
//
// This pins the two compiler halves of the per-feature channel, and one DECOY
// that catches the wrong insertion point: the converter spells a negative
// CONSTANT as `label-sort-key-[-3]` — the same bracket-binding syntax the
// expression form uses — so a lowering arm placed before the constant fold would
// turn every negative constant into a per-feature expression, breaking the
// byte-identity of every style that authors one and defeating the
// applyFeatureExprs cache.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'

function convert(sortKey: unknown): { xgis: string; warnings: string[] } {
  const coverage = { sources: [], layers: [], warnings: [] as string[] }
  const style = {
    version: 8,
    sources: { src: { type: 'vector', tiles: ['https://x/{z}/{x}/{y}.pbf'] } },
    layers: [
      {
        id: 'l',
        type: 'symbol',
        source: 'src',
        'source-layer': 'poi',
        layout: { 'text-field': '{name}', 'symbol-sort-key': sortKey },
      },
    ],
  }
  const xgis = convertMapboxStyle(style as never, { coverage } as never)
  return { xgis, warnings: coverage.warnings }
}

function compileLabel(sortKey: unknown): {
  label: { sortKey?: number; sortKeyExpr?: { ast: unknown } }
  diagnostics: Array<{ code?: string; message: string }>
} {
  const { xgis } = convert(sortKey)
  const scene = lower(new Parser(new Lexer(xgis).tokenize()).parse())
  let label = {} as { sortKey?: number; sortKeyExpr?: { ast: unknown } }
  for (const n of scene.renderNodes) {
    const l = (n as { label?: typeof label }).label
    if (l) label = l
  }
  return { label, diagnostics: scene.diagnostics as never }
}

describe('#2166 — converter emits the per-feature sort key', () => {
  it('["get","rank"] emits the bracket-binding utility instead of warning-and-dropping', () => {
    // FAIL-BEFORE: emits nothing and warns
    // 'symbol-sort-key expression form not supported yet; flattened to 0.'
    const { xgis, warnings } = convert(['get', 'rank'])
    expect(xgis).toContain('label-sort-key-[.rank]')
    expect(warnings.filter((w) => w.includes('symbol-sort-key'))).toEqual([])
  })

  it('a case/match expression converts too (the real basemap shape)', () => {
    const { xgis } = convert(['match', ['get', 'class'], 'city', 1, 9])
    expect(xgis).toContain('label-sort-key-[')
    expect(xgis).toContain('match(.class)')
  })

  it('an UNCONVERTIBLE expression still warns, and names the property', () => {
    const { xgis, warnings } = convert(['feature-state', 'hover'])
    expect(xgis).not.toContain('label-sort-key')
    const w = warnings.find((x) => x.includes('symbol-sort-key'))
    expect(w).toBeDefined()
    expect(w).toContain('symbol-sort-key')
  })

  it('BYTE-IDENTITY: the constant forms emit exactly what they always did', () => {
    expect(convert(3).xgis).toContain('label-sort-key-3')
    expect(convert(-3).xgis).toContain('label-sort-key-[-3]')
    expect(convert(3).warnings.filter((w) => w.includes('symbol-sort-key'))).toEqual([])
  })
})

describe('#2166 — lowering threads it to LabelDef.sortKeyExpr', () => {
  it('["get","rank"] lowers to sortKeyExpr, not to a constant', () => {
    // FAIL-BEFORE: no `label-sort-key` utility exists to lower.
    const { label, diagnostics } = compileLabel(['get', 'rank'])
    // CAUSE BEFORE EFFECT (§12). The X-GIS0005 fallthrough is the arm's
    // immediate neighbour in lower-label.ts: a `label-*` bracket binding with no
    // handler lands there instead of being threaded. Asserting it FIRST means a
    // severed arm reds naming the missing handler, not the empty field it left.
    expect(
      diagnostics.filter((d) => d.code === 'X-GIS0005').map((d) => d.message),
      'label-sort-key reached the no-handler fallthrough — the lower-label.ts arm is missing',
    ).toEqual([])
    expect(label.sortKeyExpr).toBeDefined()
    expect(label.sortKeyExpr?.ast).toBeDefined()
    expect(label.sortKey).toBeUndefined()
  })

  it('THE DECOY: label-sort-key-[-3] still folds to the CONSTANT sortKey -3', () => {
    const { label } = compileLabel(-3)
    expect(label.sortKey).toBe(-3)
    expect(label.sortKeyExpr).toBeUndefined()
  })

  it('a positive constant is unchanged too', () => {
    const { label } = compileLabel(7)
    expect(label.sortKey).toBe(7)
    expect(label.sortKeyExpr).toBeUndefined()
  })
})
