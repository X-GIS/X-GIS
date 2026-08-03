// ═══ Parameterized presets (#1536) — parser shapes ═══
// Step-2 surface: `preset name(a, b) { … }` declarations and
// `apply-name(args…)` utility items. Written fail-before: each case
// pins the post-change AST shape.

import { describe, expect, it } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import type * as AST from '../parser/ast'
import { withPragma } from './_pragma'

function parse(source: string): AST.Program {
  const tokens = new Lexer(withPragma(source)).tokenize()
  return new Parser(tokens).parse()
}

function firstPreset(source: string): AST.PresetStatement {
  const stmt = parse(source).body.find((s) => s.kind === 'PresetStatement')
  if (!stmt) throw new Error('no PresetStatement parsed')
  return stmt as AST.PresetStatement
}

function firstLayerItems(source: string): AST.UtilityItem[] {
  const stmt = parse(source).body.find((s) => s.kind === 'LayerStatement') as
    AST.LayerStatement | undefined
  if (!stmt) throw new Error('no LayerStatement parsed')
  return stmt.utilities.flatMap((l) => l.items)
}

describe('preset parameter declarations (#1536)', () => {
  it('parses `preset glow(color, radius)` into params', () => {
    const p = firstPreset('preset glow(color, radius) { | stroke-[color] stroke-[radius] }')
    expect(p.name).toBe('glow')
    expect(p.params).toEqual(['color', 'radius'])
    expect(p.utilities).toHaveLength(1)
  })

  it('zero-arg presets keep parsing with no params (back-compat)', () => {
    const p = firstPreset('preset plain { | fill-red-500 }')
    expect(p.name).toBe('plain')
    expect(p.params).toBeUndefined()
  })

  it('single-param declaration parses', () => {
    const p = firstPreset('preset halo(width) { | stroke-[width] }')
    expect(p.params).toEqual(['width'])
  })
})

describe('apply-<preset>(args) utility items (#1536)', () => {
  const SRC = `
source w { type: geojson, url: "w.geojson" }
preset glow(color, radius) { | stroke-[color] stroke-[radius] }
layer roads {
  source: w
  | apply-glow(#f59e0b, 4) opacity-80
}
`

  it('parses call-form apply items into UtilityItem.args', () => {
    const items = firstLayerItems(SRC)
    const apply = items.find((i) => i.name === 'apply-glow')
    expect(apply).toBeDefined()
    expect(apply!.args).toHaveLength(2)
    expect(apply!.args![0].kind).toBe('ColorLiteral')
    expect(apply!.args![1].kind).toBe('NumberLiteral')
  })

  it('sibling items after the call survive', () => {
    const items = firstLayerItems(SRC)
    expect(items.some((i) => i.name === 'opacity-80')).toBe(true)
  })

  it('bare apply items keep args undefined (back-compat)', () => {
    const items = firstLayerItems(`
source w { type: geojson, url: "w.geojson" }
preset plain { | fill-red-500 }
layer l { source: w  | apply-plain }
`)
    const apply = items.find((i) => i.name === 'apply-plain')
    expect(apply).toBeDefined()
    expect(apply!.args).toBeUndefined()
  })
})

// ═══ Step-3 semantics: substitution, arity, hygiene ═══

import { expandPresets, resolveStylePreset, type PresetDef } from '../ir/preset-expand'
import type { Diagnostic } from '../diagnostics/diagnostic'
import { lower } from '../ir/lower'

/** Parse a program and hand back its preset map + a layer's utility lines,
 *  mirroring lower()'s first pass. */
function presetFixture(source: string) {
  const program = parse(source)
  const presetMap = new Map<string, PresetDef>()
  for (const s of program.body) {
    if (s.kind === 'PresetStatement') {
      presetMap.set(s.name, { utilities: s.utilities, properties: s.properties, params: s.params })
    }
  }
  const layer = program.body.find((s) => s.kind === 'LayerStatement') as AST.LayerStatement
  return { presetMap, layer }
}

describe('preset parameter substitution (#1536 step 3)', () => {
  it('substitutes apply-call args into utility bindings', () => {
    const { presetMap, layer } = presetFixture(`
source w { type: geojson, url: "w.geojson" }
preset glow(color, radius) { | fill-[color] stroke-[radius] }
layer l { source: w  | apply-glow(#f59e0b, 4) }
`)
    const diagnostics: Diagnostic[] = []
    const expanded = expandPresets(layer.utilities, presetMap, diagnostics)
    expect(diagnostics).toHaveLength(0)
    const items = expanded.flatMap((l) => l.items)
    const fill = items.find((i) => i.name === 'fill')!
    expect(fill.binding?.kind).toBe('ColorLiteral')
    const stroke = items.find((i) => i.name === 'stroke')!
    expect(stroke.binding).toMatchObject({ kind: 'NumberLiteral', value: 4 })
  })

  it('substitutes params inside compound expressions, leaving .field access alone', () => {
    const { presetMap, layer } = presetFixture(`
source w { type: geojson, url: "w.geojson" }
preset p(x) { | size-[.x + x] }
layer l { source: w  | apply-p(5) }
`)
    const diagnostics: Diagnostic[] = []
    const expanded = expandPresets(layer.utilities, presetMap, diagnostics)
    const size = expanded.flatMap((l) => l.items).find((i) => i.name === 'size')!
    expect(size.binding).toMatchObject({
      kind: 'BinaryExpr',
      op: '+',
      left: { kind: 'FieldAccess', field: 'x' },
      right: { kind: 'NumberLiteral', value: 5 },
    })
  })

  it('does not mutate the preset definition across two call sites', () => {
    const { presetMap, layer } = presetFixture(`
source w { type: geojson, url: "w.geojson" }
preset p(n) { | stroke-[n] }
layer l { source: w  | apply-p(1)  | apply-p(2) }
`)
    const diagnostics: Diagnostic[] = []
    const expanded = expandPresets(layer.utilities, presetMap, diagnostics)
    const strokes = expanded.flatMap((l) => l.items).filter((i) => i.name === 'stroke')
    expect(strokes.map((s) => (s.binding as { value?: number }).value)).toEqual([1, 2])
    // The stored definition itself is untouched (still the bare param).
    expect(presetMap.get('p')!.utilities[0]!.items[0]!.binding?.kind).toBe('Identifier')
  })

  it('arity mismatch is an X-GIS0014 error at the call-site line', () => {
    const { presetMap, layer } = presetFixture(`
source w { type: geojson, url: "w.geojson" }
preset p(a, b) { | stroke-[a] }
layer l { source: w  | apply-p(1) }
`)
    const diagnostics: Diagnostic[] = []
    expandPresets(layer.utilities, presetMap, diagnostics)
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toMatchObject({ code: 'X-GIS0014', severity: 'error' })
  })

  it('args on a zero-param preset are an X-GIS0014 error', () => {
    const { presetMap, layer } = presetFixture(`
source w { type: geojson, url: "w.geojson" }
preset plain { | fill-red-500 }
layer l { source: w  | apply-plain(3) }
`)
    const diagnostics: Diagnostic[] = []
    expandPresets(layer.utilities, presetMap, diagnostics)
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toMatchObject({ code: 'X-GIS0014', severity: 'error' })
  })

  it('resolveStylePreset substitutes block properties (coverage ramp/range)', () => {
    const { presetMap } = presetFixture(`
source w { type: geojson, url: "w.geojson" }
preset s111(hi) { ramp: "s111-speed"  range: [0, hi] }
layer l { source: w }
`)
    const diagnostics: Diagnostic[] = []
    const inst = resolveStylePreset(
      presetMap,
      { name: 's111', args: [{ kind: 'NumberLiteral', value: 13, unit: null }], line: 5 },
      diagnostics,
    )
    expect(diagnostics).toHaveLength(0)
    const range = inst!.properties.find((p) => p.name === 'range')!
    expect(range.value).toMatchObject({
      kind: 'ArrayLiteral',
      elements: [{ kind: 'NumberLiteral' }, { kind: 'NumberLiteral', value: 13 }],
    })
  })

  it('lower() accepts the style: call form without X-GIS0012', () => {
    const scene = lower(
      parse(`
source w { type: geojson, url: "w.geojson" }
preset glow(color) { | fill-[color] }
layer l {
  source: w
  style: glow(#f59e0b)
}
`),
    )
    expect((scene.diagnostics ?? []).filter((d) => d.severity === 'error')).toHaveLength(0)
  })
})
