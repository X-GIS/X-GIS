// #2310: a Mapbox `text-field` token string whose keys carry a colon
// (`"{name:latin}\n{name:nonlatin}"` — the canonical OpenMapTiles
// bilingual label used by osm-bright / positron / dark-matter) used to
// convert verbatim into an xgis template string. The template parser
// then read the `:` as a format-spec separator and parseFormatSpec
// threw, so lower() aborted and EVERY layer of the style was lost —
// not just the symbol one. These tests pin the whole pipeline:
// convert → parse → lower → evaluate.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'
import { evaluate } from '../eval/evaluator'
import type { LabelDef, TextValue } from '../ir/render-node'

function styleWithTextField(field: unknown): object {
  return {
    version: 8,
    sources: { v: { type: 'vector', tiles: ['https://e.com/{z}/{x}/{y}.pbf'] } },
    layers: [
      {
        id: 'water',
        type: 'fill',
        source: 'v',
        'source-layer': 'water',
        paint: { 'fill-color': '#00f' },
      },
      {
        id: 'city_label',
        type: 'symbol',
        source: 'v',
        'source-layer': 'place',
        layout: { 'text-field': field },
      },
    ],
  }
}

/** convert → lex → parse → lower, surfacing the emitted xgis on throw. */
function lowerStyle(field: unknown): ReturnType<typeof lower> {
  const out = convertMapboxStyle(styleWithTextField(field) as never)
  const ast = new Parser(new Lexer(out).tokenize()).parse()
  try {
    return lower(ast)
  } catch (e) {
    throw new Error(`lower() THREW: ${(e as Error).message}\n--- emitted ---\n${out}`)
  }
}

function labelOf(scene: ReturnType<typeof lower>): LabelDef {
  const node = scene.renderNodes.find((n) => n.name.startsWith('city_label')) as
    { label?: LabelDef } | undefined
  expect(node?.label).toBeDefined()
  return node!.label!
}

function resolveText(text: TextValue, props: Record<string, unknown>): string {
  if (text.kind === 'expr') return String(evaluate(text.expr.ast, props))
  return text.parts
    .map((p) => (p.kind === 'literal' ? p.value : String(evaluate(p.expr.ast, props))))
    .join('')
}

const SEOUL = { name: '서울', 'name:latin': 'Seoul', 'name:nonlatin': '서울' }

describe('#2310 text-field locale tokens survive convert → lower', () => {
  it('multi-token bilingual template resolves both locale keys', () => {
    const scene = lowerStyle('{name:latin}\n{name:nonlatin}')
    expect(resolveText(labelOf(scene).text, SEOUL)).toBe('Seoul\n서울')
  })

  it('single locale token resolves the locale key, not the base name', () => {
    const scene = lowerStyle('{name:latin}')
    expect(resolveText(labelOf(scene).text, SEOUL)).toBe('Seoul')
  })

  it('locale token mixed with literal text and an identifier token', () => {
    const scene = lowerStyle('{name:latin} ({ref})')
    expect(resolveText(labelOf(scene).text, { ...SEOUL, ref: 'KR' })).toBe('Seoul (KR)')
  })

  it('the rest of the style still lowers (no whole-scene loss)', () => {
    const scene = lowerStyle('{name:latin}\n{name:nonlatin}')
    expect(scene.renderNodes.map((n) => n.name)).toContain('water')
  })

  it('identifier-only token strings keep the template shape', () => {
    const scene = lowerStyle('{name} ({ref})')
    expect(resolveText(labelOf(scene).text, { name: 'Seoul', ref: 'KR' })).toBe('Seoul (KR)')
  })
})
