import { describe, expect, it } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'
import { optimize } from '../ir/optimize'
import { emitCommands } from '../ir/emit-commands'

function compile(source: string) {
  const tokens = new Lexer(source).tokenize()
  const ast = new Parser(tokens).parse()
  // Run the same optimize pass production uses, so regressions that strip
  // the field cannot slip through (this has happened before for stroke
  // fields — see line-dash.test.ts regression guard).
  return emitCommands(optimize(lower(ast), ast))
}

describe('anchor-* utilities', () => {
  const BASE = `
    source pts { type: geojson url: "cities.geojson" }
    layer markers {
      source: pts
      | fill-rose-500 size-8
  `

  it('defaults to undefined when no anchor utility is present', () => {
    const commands = compile(BASE + `
      }
    `)
    expect(commands.shows[0].anchor).toBeUndefined()
  })

  it('parses anchor-bottom into ShowCommand.anchor', () => {
    const commands = compile(BASE + `
      anchor-bottom
      }
    `)
    expect(commands.shows[0].anchor).toBe('bottom')
  })

  it('parses anchor-top into ShowCommand.anchor', () => {
    const commands = compile(BASE + `
      anchor-top
      }
    `)
    expect(commands.shows[0].anchor).toBe('top')
  })

  it('parses anchor-center explicitly', () => {
    const commands = compile(BASE + `
      anchor-center
      }
    `)
    expect(commands.shows[0].anchor).toBe('center')
  })

  it('survives the optimize pass (regression guard)', () => {
    // If optimizeNode stops spreading `...node` one day, anchor would
    // vanish just like dashArray did in an earlier version. Keep this
    // guard so the DSL-to-GPU flow stays intact.
    const commands = compile(BASE + `
      anchor-bottom stroke-white stroke-2
      }
    `)
    const show = commands.shows[0]
    expect(show.anchor).toBe('bottom')
    expect(show.strokeWidth).toBe(2)
  })
})
