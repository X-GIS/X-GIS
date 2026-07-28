// ═══ `flow-portrayal` — the portrayal is declarable, the mechanism is not (#1418) ═══
//
// IBFV is a MECHANISM: a velocity field advected on the GPU. How that motion is SHOWN is a
// separate decision, and it has to be expressible or every consumer silently gets whichever
// presentation happened to be hard-coded. `| flow` alone could not say it — it lowered to a
// bare boolean — which is why several revisions of this work treated "IBFV" and "moving
// arrows" as an either/or and deleted one to build the other.

import { describe, expect, it } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'
import { withPragma } from './_pragma'

function compile(source: string) {
  const tokens = new Lexer(withPragma(source)).tokenize()
  const ast = new Parser(tokens).parse()
  return lower(ast)
}

/** The portrayal is a MODIFIER on the flow pipe, not a `key: value` property: a hyphenated
 *  name is not expressible in the property namespace (the lexer splits it), and `bearing-N`
 *  already establishes this shape for a utility that carries a value. */
const flowLayer = (pipe = 'flow') =>
  compile(`
    source currents { type: coverage, url: "cbofs.h5" }
    layer speed {
      source: currents
      | arrow
      | ${pipe}
    }
  `).renderNodes.find((n) => n.name === 'speed')!

describe('flow-portrayal lowering (#1418)', () => {
  it('is UNSET when not authored — the default is resolved at arm time, not spelled here', () => {
    // Deliberately undefined rather than eagerly defaulted to 'arrows': ONE authority for the
    // default. Baking it in at lowering would put a second copy in the IR that a later change
    // to the arm's default would silently contradict.
    const n = flowLayer()
    expect(n.isFlow).toBe(true)
    expect(n.flowPortrayal).toBeUndefined()
  })

  it('carries `arrows` — the catalogue glyphs are what moves', () => {
    expect(flowLayer('flow-arrows').flowPortrayal).toBe('arrows')
  })

  it('carries `streaks` — the advected image itself', () => {
    expect(flowLayer('flow-streaks').flowPortrayal).toBe('streaks')
  })

  it('an unknown modifier does NOT quietly become a flow layer', () => {
    // `| flow-sparkles` must not match the flow handler and silently animate with the default
    // portrayal — a typo that still "works" is indistinguishable from the feature working, the
    // worst failure mode for a declarative surface. It falls through to the compiler's
    // unknown-utility diagnostic instead.
    const n = flowLayer('flow-sparkles')
    expect(n.isFlow).toBeFalsy()
    expect(n.flowPortrayal).toBeUndefined()
  })

  it('both modifiers still mark the layer as flowing', () => {
    expect(flowLayer('flow-arrows').isFlow).toBe(true)
    expect(flowLayer('flow-streaks').isFlow).toBe(true)
  })

  it('does not touch a layer that never asked for flow', () => {
    const n = compile(`
      source currents { type: coverage, url: "cbofs.h5" }
      layer speed {
        source: currents
        | arrow
      }
    `).renderNodes.find((x) => x.name === 'speed')!
    expect(n.isFlow).toBeFalsy()
    expect(n.flowPortrayal).toBeUndefined()
  })
})
