import { describe, expect, it } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'
import { optimize } from '../ir/optimize'
import { emitCommands } from '../ir/emit-commands'

function compile(source: string) {
  const tokens = new Lexer(source).tokenize()
  const ast = new Parser(tokens).parse()
  return emitCommands(optimize(lower(ast), ast))
}

const BASE = `
  source coast { type: geojson url: "ne_110m_coastline.geojson" }
  layer line {
    source: coast
    | stroke-cyan-400 stroke-2
`

describe('stroke-offset utility', () => {
  it('defaults to undefined when no offset utility is present', () => {
    const c = compile(BASE + '  }\n')
    expect(c.shows[0].strokeOffset).toBeUndefined()
  })

  it('parses stroke-offset-5 as positive (left of travel)', () => {
    const c = compile(BASE + '    | stroke-offset-5\n  }\n')
    expect(c.shows[0].strokeOffset).toBe(5)
  })

  it('parses stroke-offset-left-7 as positive', () => {
    const c = compile(BASE + '    | stroke-offset-left-7\n  }\n')
    expect(c.shows[0].strokeOffset).toBe(7)
  })

  it('parses stroke-offset-right-3 as negative', () => {
    const c = compile(BASE + '    | stroke-offset-right-3\n  }\n')
    expect(c.shows[0].strokeOffset).toBe(-3)
  })

  it('survives the optimize pass (regression guard for stroke spread)', () => {
    // Same regression that bit dashArray earlier — make sure the
    // optimizer's stroke field spread carries `offset` through.
    const c = compile(BASE + '    | stroke-offset-4 stroke-round-join\n  }\n')
    const show = c.shows[0]
    expect(show.strokeOffset).toBe(4)
    expect(show.linejoin).toBe('round')
  })

  describe('stroke-inset / stroke-outset alignment', () => {
    it('parses stroke-inset into strokeAlign', () => {
      const c = compile(BASE + '    | stroke-inset\n  }\n')
      expect(c.shows[0].strokeAlign).toBe('inset')
    })

    it('parses stroke-outset into strokeAlign', () => {
      const c = compile(BASE + '    | stroke-outset\n  }\n')
      expect(c.shows[0].strokeAlign).toBe('outset')
    })

    it('parses stroke-center into strokeAlign', () => {
      const c = compile(BASE + '    | stroke-center\n  }\n')
      expect(c.shows[0].strokeAlign).toBe('center')
    })

    it('combines with explicit stroke-offset (sum semantics)', () => {
      // strokeOffset and strokeAlign are independent IR fields;
      // the runtime resolves effectiveOffset = strokeOffset ± half_w.
      const c = compile(BASE + '    | stroke-inset stroke-offset-2\n  }\n')
      const show = c.shows[0]
      expect(show.strokeAlign).toBe('inset')
      expect(show.strokeOffset).toBe(2)
    })

    it('survives the optimize pass', () => {
      const c = compile(BASE + '    | stroke-inset stroke-round-join\n  }\n')
      const show = c.shows[0]
      expect(show.strokeAlign).toBe('inset')
      expect(show.linejoin).toBe('round')
    })
  })
})
