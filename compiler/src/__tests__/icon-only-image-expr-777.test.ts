// Issue #777 Phase I (I1 + I2) — icon/sprite converter completion.
//
// I1. Icon-only symbol layers with a DATA-DRIVEN icon-image (no
//     text-field) were dropped at convert: the icon-only branch only
//     fired for a constant string icon-image (`typeof iconImage ===
//     'string'`), so `["get", …]` / `["match", …]` / `["coalesce", …]`
//     icon-image on a text-less POI layer emitted `// SKIPPED … no
//     text-field or icon-image` and never reached the (already working)
//     runtime iconImageExpr → applyFeatureExprs → IconStage.addIcon
//     dispatch. Route it like the constant path: empty-text label +
//     bracket-bound iconImageExpr.
//
// I2. The `["image", <name>]` expression (Mapbox ResolvedImage) was in
//     KNOWN_UNSUPPORTED, so any icon-image authored as `["image", …]`
//     (and the common `["coalesce", ["image", …], ["image", …]]` POI
//     shape) dropped. In the icon-image property context the `image`
//     wrapper is a compile-time identity — strip it (recursively, incl.
//     nested inside coalesce/match arms) and lower the inner sprite-name
//     expression. Text-inline `["format", …, ["image", …]]` spans stay
//     deferred (still handled by the format partial-drop path).

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'
import { evaluate, makeEvalProps } from '../index'

interface CompiledLabel {
  text?: unknown
  iconImage?: string
  iconImageExpr?: { ast: unknown }
}

/** convert → lex → parse → lower; return the first render node's
 *  LabelDef. Icon-only symbols keep an empty-text label whose
 *  iconImage / iconImageExpr drive IconStage. */
function compileLabel(layer: Record<string, unknown>): CompiledLabel {
  const program = new Parser(new Lexer(convert(layer)).tokenize()).parse()
  const scene = lower(program)
  for (const n of scene.renderNodes) {
    const label = (n as { label?: unknown }).label
    if (label) return label as CompiledLabel
  }
  return {}
}

/** Raw converter output — for the not-dropped / SKIPPED assertions. */
function convert(layer: Record<string, unknown>): string {
  const style = {
    version: 8,
    sprite: 'https://example/sprites/foo',
    sources: { src: { type: 'vector', tiles: ['https://x/{z}/{x}/{y}.pbf'] } },
    layers: [layer],
  }
  return convertMapboxStyle(style as never)
}

const base = { id: 'poi', type: 'symbol', source: 'src', 'source-layer': 'poi' } as const

describe('#777 I1 — icon-only symbol layers with a data-driven icon-image route to the icon stage', () => {
  it('["match", …] icon-image with NO text-field is NOT dropped and lowers to iconImageExpr', () => {
    const layer = {
      ...base,
      layout: { 'icon-image': ['match', ['get', 'class'], 'park', 'park_11', 'school_11'] },
    }
    const out = convert(layer)
    expect(out).not.toContain('// SKIPPED')
    expect(out).toContain('label-icon-image-[')
    const def = compileLabel(layer)
    expect(def.iconImageExpr).toBeDefined()
    // Icon-only → empty-text label, no constant iconImage fallback.
    expect(def.iconImage).toBeUndefined()
  })

  it('["get", …] icon-image with NO text-field lowers to iconImageExpr', () => {
    const def = compileLabel({ ...base, layout: { 'icon-image': ['get', 'maki'] } })
    expect(def.iconImageExpr).toBeDefined()
    expect(def.iconImage).toBeUndefined()
  })

  it('a truly empty symbol layer (no text-field, no icon-image) still drops', () => {
    const out = convert({ ...base, layout: {} })
    expect(out).toContain('// SKIPPED')
  })
})

describe('#777 I2 — ["image", …] expression resolves in the icon-image context', () => {
  it('["image", "airport"] (constant) with a text-field resolves to iconImage "airport"', () => {
    const def = compileLabel({
      ...base,
      layout: { 'icon-image': ['image', 'airport'], 'text-field': '{name}' },
    })
    expect(def.iconImage).toBe('airport')
  })

  it('["image", "airport"] (constant) with NO text-field is icon-only with iconImage "airport"', () => {
    const def = compileLabel({ ...base, layout: { 'icon-image': ['image', 'airport'] } })
    expect(def.iconImage).toBe('airport')
    expect(def.iconImageExpr).toBeUndefined()
  })

  it('["image", ["get","maki"]] (data-driven) lowers to iconImageExpr (image wrapper stripped)', () => {
    const def = compileLabel({ ...base, layout: { 'icon-image': ['image', ['get', 'maki']] } })
    expect(def.iconImageExpr).toBeDefined()
    expect(def.iconImage).toBeUndefined()
  })

  it('["coalesce", ["image", ["concat", …]], ["image", "marker_11"]] (nested image, the POI shape) lowers', () => {
    const layer = {
      ...base,
      layout: {
        'icon-image': [
          'coalesce',
          ['image', ['concat', ['get', 'class'], '_11']],
          ['image', 'marker_11'],
        ],
      },
    }
    const out = convert(layer)
    expect(out).not.toContain('// SKIPPED')
    const def = compileLabel(layer)
    expect(def.iconImageExpr).toBeDefined()
  })

  it('["image", …] inside a ["format", …] text span still drops (text-inline images deferred)', () => {
    // The format/exprToXgis path is unchanged — image stays unsupported
    // there so the deferred text-inline-image gap keeps its warning
    // instead of rendering the sprite name as literal text.
    const def = compileLabel({
      ...base,
      layout: { 'text-field': ['format', 'A ', {}, ['image', 'airport'], {}, ' B', {}] },
    })
    // The surviving text sections still concat; the image span is dropped.
    expect(def.iconImage).toBeUndefined()
    expect(def.iconImageExpr).toBeUndefined()
  })
})

// Bridge the emitted IR to the runtime: the LabelDef.iconImageExpr AST
// the converter now emits for these previously-dropped shapes must
// evaluate (via the same runtime evaluator + makeEvalProps that
// label-pass.ts applyFeatureExprs uses) to the sprite key that
// dispatchIcon feeds to IconStage.addIcon. Non-GPU, but proves the
// converter output is runtime-correct per feature — the exact contract
// icon-image-step-zoom.test.ts pins for the text-paired path.
describe('#777 I1/I2 — emitted iconImageExpr resolves per feature in the runtime evaluator', () => {
  it('icon-only ["match", ["get","class"], …] resolves to the matched sprite per feature', () => {
    const def = compileLabel({
      ...base,
      layout: {
        'icon-image': ['match', ['get', 'class'], 'park', 'park_11', 'school'],
      },
    })
    const ast = def.iconImageExpr!.ast
    expect(
      evaluate(ast as never, makeEvalProps({ props: { class: 'park' }, cameraZoom: 14 })),
    ).toBe('park_11')
    expect(
      evaluate(ast as never, makeEvalProps({ props: { class: 'library' }, cameraZoom: 14 })),
    ).toBe('school')
  })

  it('icon-only ["image", ["get","maki"]] resolves to the feature\'s maki value', () => {
    const def = compileLabel({ ...base, layout: { 'icon-image': ['image', ['get', 'maki']] } })
    const ast = def.iconImageExpr!.ast
    expect(
      evaluate(ast as never, makeEvalProps({ props: { maki: 'cafe_11' }, cameraZoom: 16 })),
    ).toBe('cafe_11')
  })

  it('icon-only coalesce+image POI shape resolves the first available sprite name', () => {
    const def = compileLabel({
      ...base,
      layout: {
        'icon-image': [
          'coalesce',
          ['image', ['concat', ['get', 'class'], '_11']],
          ['image', 'marker_11'],
        ],
      },
    })
    const ast = def.iconImageExpr!.ast
    expect(evaluate(ast as never, makeEvalProps({ props: { class: 'bus' }, cameraZoom: 16 }))).toBe(
      'bus_11',
    )
  })
})
