// ═══ #2534 — the six translate binding handlers are one factory ═══
//
// `fill` / `circle` / `stroke` × `x` / `y` each had its own `BindingHandler`
// whose bodies were byte-identical apart from the utility name and which
// `TranslateShape` field they filled. They now come from
// `translateShapeHandler` (lower-bindings.ts).
//
// Only the fill pair had a test asserting its shape — `fill-translate-end-to-
// end.test.ts` — so four of the six could have been rewritten wrongly with
// every gate still green. All six are covered here, each asserting that it
// fills its OWN field and leaves its five siblings alone; a factory that
// captured the wrong field would pass one arm and fail the others.
//
// The decline contract is covered too, and nothing asserted it before: a
// matched handler that returns `false` must NOT stop `dispatch`'s scan, which
// is how a constant `-[-2]` still reaches the numeric-const arm in
// `bindingFallthroughHandler`. Fold that invariant wrong and the constant form
// silently disappears instead of landing in the scalar field.

import { describe, expect, it } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'
import type { RenderNode } from '../ir/render-node'
import { withPragma } from './_pragma'

function nodeFor(utilities: string): RenderNode {
  const src = `source s { type: geojson, url: "s.geojson" }\nlayer l { source: s | ${utilities} }`
  const scene = lower(new Parser(new Lexer(withPragma(src)).tokenize()).parse())
  const node = scene.renderNodes[0]
  if (!node) throw new Error(`no render node for: ${utilities}`)
  return node
}

const STOPS = 'interpolate(zoom, 5, 0, 15, 10)'
const EXPECTED = {
  kind: 'zoom-interpolated',
  stops: [
    { zoom: 5, value: 0 },
    { zoom: 15, value: 10 },
  ],
  base: 1,
}

/** Every shape field the factory can write, so each case can assert that the
 *  five it does NOT own stayed undefined. */
const SHAPE_FIELDS = [
  'fillTranslateXShape',
  'fillTranslateYShape',
  'circleTranslateXShape',
  'circleTranslateYShape',
  'strokeTranslateXShape',
  'strokeTranslateYShape',
] as const

const CASES: ReadonlyArray<readonly [string, (typeof SHAPE_FIELDS)[number]]> = [
  ['fill-translate-x', 'fillTranslateXShape'],
  ['fill-translate-y', 'fillTranslateYShape'],
  ['circle-translate-x', 'circleTranslateXShape'],
  ['circle-translate-y', 'circleTranslateYShape'],
  ['stroke-translate-x', 'strokeTranslateXShape'],
  ['stroke-translate-y', 'strokeTranslateYShape'],
]

describe('#2534 translateShapeHandler — each of the six fills its own field', () => {
  for (const [utility, field] of CASES) {
    it(`${utility}-[interpolate(…)] fills ${field} and nothing else`, () => {
      const node = nodeFor(`${utility}-[${STOPS}]`)
      expect(node[field]).toEqual(EXPECTED)
      for (const other of SHAPE_FIELDS) {
        if (other !== field) expect(node[other]).toBeUndefined()
      }
    })
  }
})

describe('#2534 translateShapeHandler — declining lets the scan continue', () => {
  // The load-bearing half: `apply` returns false on a non-interpolate binding,
  // and `dispatch` must keep walking so the numeric-const arm still sees it.
  it('a constant binding produces NO shape but DOES set the scalar', () => {
    const node = nodeFor('fill-translate-x-[-2]')
    expect(node.fillTranslateXShape).toBeUndefined()
    expect(node.fillTranslateX).toBe(-2)
  })

  it('the same holds for the circle and stroke families', () => {
    const circle = nodeFor('circle-translate-y-[-3]')
    expect(circle.circleTranslateYShape).toBeUndefined()
    expect(circle.circleTranslateY).toBe(-3)

    const stroke = nodeFor('stroke-translate-x-[-4]')
    expect(stroke.strokeTranslateXShape).toBeUndefined()
    expect(stroke.strokeTranslateX).toBe(-4)
  })
})
