// ═══ Vector values (#1537) — vec2/vec3/vec4 + component access ═══
// Step A pins the CPU semantics (construction, component access, the
// shapes that must NOT change meaning); step B adds the typed GPU
// lowering and promotes the constructors to GPU-safe.

import { describe, expect, it } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser, parseExpressionString } from '../parser/parser'
import type * as AST from '../parser/ast'
import { withPragma } from './_pragma'
import { evaluate } from '../eval/evaluator'
import { lower } from '../ir/lower'

function parse(source: string): AST.Program {
  return new Parser(new Lexer(withPragma(source)).tokenize()).parse()
}

const ev = (src: string, props: Record<string, unknown> = {}) =>
  evaluate(parseExpressionString(src), props)

describe('vec constructors — CPU evaluation (#1537)', () => {
  it('vec2/vec3/vec4 build fixed-length numeric tuples', () => {
    expect(ev('vec2(1, 2)')).toEqual([1, 2])
    expect(ev('vec3(1, 2, 3)')).toEqual([1, 2, 3])
    expect(ev('vec4(1, 2, 3, 4)')).toEqual([1, 2, 3, 4])
  })

  it('arguments are ordinary expressions (feature fields, arithmetic)', () => {
    expect(ev('vec2(.w * 2, 1 + 1)', { w: 5 })).toEqual([10, 2])
  })

  it('a scalar argument broadcasts to every lane (WGSL splat)', () => {
    expect(ev('vec3(0.5)')).toEqual([0.5, 0.5, 0.5])
    expect(ev('vec4(0)')).toEqual([0, 0, 0, 0])
  })

  it('a vec argument flattens into the constructed vector (WGSL concat)', () => {
    expect(ev('vec4(vec3(1, 2, 3), 4)')).toEqual([1, 2, 3, 4])
    expect(ev('vec4(vec2(1, 2), vec2(3, 4))')).toEqual([1, 2, 3, 4])
  })

  it('wrong lane count is a hard error, not a silent truncation', () => {
    expect(() => ev('vec3(1, 2)')).toThrow(/vec3/)
    expect(() => ev('vec2(1, 2, 3)')).toThrow(/vec2/)
  })
})

describe('component access (#1537)', () => {
  it('.x/.y/.z/.w select lanes of a vec value', () => {
    expect(ev('vec4(10, 20, 30, 40).x')).toBe(10)
    expect(ev('vec4(10, 20, 30, 40).y')).toBe(20)
    expect(ev('vec4(10, 20, 30, 40).z')).toBe(30)
    expect(ev('vec4(10, 20, 30, 40).w')).toBe(40)
  })

  it('rgba aliases select the same lanes', () => {
    expect(ev('vec4(10, 20, 30, 40).r')).toBe(10)
    expect(ev('vec4(10, 20, 30, 40).a')).toBe(40)
  })

  it('an out-of-range lane is null (vec2 has no .z)', () => {
    expect(ev('vec2(1, 2).z')).toBeNull()
  })

  it('IMPLICIT `.field` still means feature-property access, never a lane', () => {
    // The object-less form is the data binding — a feature property named
    // `x` must keep winning over any component reading.
    expect(ev('.x', { x: 42 })).toBe(42)
  })

  it('component access on a non-vec object stays null (no coercion)', () => {
    expect(ev('.name.x', { name: 'seoul' })).toBeNull()
  })
})

describe('vec values in a layer binding (#1537)', () => {
  it('lower() accepts a vec-component binding with no error diagnostics', () => {
    const scene = lower(
      parse(`
source w { type: geojson, url: "w.geojson" }
layer l {
  source: w
  | size-[vec3(.w, .w * 2, 8).y]
}
`),
    )
    expect((scene.diagnostics ?? []).filter((d) => d.severity === 'error')).toEqual([])
  })
})
