// label-* utilities that allow negative values must accept the
// bracket-binding form `label-offset-y-[-0.2]` (the utility-name
// grammar uses `-` as a segment separator, so `label-offset-y--0.2`
// is malformed). The lower pass evaluates the constant binding and
// writes the value into the LabelDef numeric fields.

import { describe, it, expect } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'
import type { LabelDef } from '../ir/render-node'

function compileLabel(utilityLine: string): LabelDef {
  const src = `
    source vt { type: geojson }
    layer cities {
      source: vt
      | label-[.name] ${utilityLine}
    }
  `
  const tokens = new Lexer(src).tokenize()
  const program = new Parser(tokens).parse()
  const scene = lower(program)
  const node = scene.renderNodes[0]!
  expect(node.label).toBeDefined()
  return node.label!
}

describe('numeric label-* utilities accept bracket-binding negatives', () => {
  it('label-offset-y-[-0.2] → offset[1] = -0.2', () => {
    const lbl = compileLabel('label-offset-y-[-0.2]')
    expect(lbl.offset).toEqual([0, -0.2])
  })

  it('label-offset-x-[-0.5] → offset[0] = -0.5', () => {
    const lbl = compileLabel('label-offset-x-[-0.5]')
    expect(lbl.offset).toEqual([-0.5, 0])
  })

  it('combined offsets — both axes', () => {
    const lbl = compileLabel('label-offset-x-[-0.5] label-offset-y-[-0.2]')
    expect(lbl.offset).toEqual([-0.5, -0.2])
  })

  it('label-rotate-[-45] → rotate = -45', () => {
    const lbl = compileLabel('label-rotate-[-45]')
    expect(lbl.rotate).toBe(-45)
  })

  it('label-letter-spacing-[-0.1] → letterSpacing = -0.1', () => {
    const lbl = compileLabel('label-letter-spacing-[-0.1]')
    expect(lbl.letterSpacing).toBe(-0.1)
  })

  it('positive bracket binding still works (uniformity)', () => {
    const lbl = compileLabel('label-offset-y-[0.4]')
    expect(lbl.offset).toEqual([0, 0.4])
  })

  it('positive inline form still works (back-compat)', () => {
    const lbl = compileLabel('label-offset-y-1.5')
    expect(lbl.offset).toEqual([0, 1.5])
  })
})
