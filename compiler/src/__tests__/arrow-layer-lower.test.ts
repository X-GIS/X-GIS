// Arrow-layer authoring surface (#1302). The `arrow` marker + `bearing`
// binding lower to RenderNode.isArrow + RenderNode.arrowBearing; the runtime
// arrow renderer (separate change) consumes them. This is the by-construction
// gate for the compiler half: prove the IR carries the intent.
import { describe, it, expect } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'
import type { RenderNode } from '../ir/render-node'

function lowerLayers(src: string): RenderNode[] {
  const tokens = new Lexer(src).tokenize()
  const { program, diagnostics } = new Parser(tokens).parseCollect()
  expect(diagnostics, JSON.stringify(diagnostics)).toEqual([])
  const scene = lower(program)
  expect(scene.diagnostics ?? [], JSON.stringify(scene.diagnostics)).toEqual([])
  return scene.renderNodes
}

const SRC = `xgis 1
source stations { type: geojson }
layer arrows {
  source: stations
  | arrow bearing-[.dir] size-[10 + sqrt(.speed) * 4] fill gradient(.speed, 0, 120, sky-300, rose-600)
}
layer arrows_const {
  source: stations
  | arrow bearing-45 size-16
}
`

describe('arrow layer lowering (#1302)', () => {
  it('`| arrow bearing-[.dir]` sets isArrow + a data-driven arrowBearing', () => {
    const node = lowerLayers(SRC).find((n) => n.name === 'arrows')
    expect(node).toBeDefined()
    expect(node!.isArrow).toBe(true)
    expect(node!.arrowBearing?.kind).toBe('data-driven')
  })

  it('`| arrow bearing-45` sets isArrow + a constant arrowBearing (degrees)', () => {
    const node = lowerLayers(SRC).find((n) => n.name === 'arrows_const')
    expect(node!.isArrow).toBe(true)
    expect(node!.arrowBearing).toEqual({ kind: 'constant', value: 45, unit: null })
  })

  it('a non-arrow layer leaves isArrow / arrowBearing undefined', () => {
    const node = lowerLayers(`xgis 1
source s { type: geojson }
layer dots { source: s | fill-sky-500 size-8 }
`).find((n) => n.name === 'dots')
    expect(node!.isArrow).toBeUndefined()
    expect(node!.arrowBearing).toBeUndefined()
  })
})
