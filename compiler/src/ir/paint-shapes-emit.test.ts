// Verifies emit-commands populates ShowCommand.paintShapes alongside
// the legacy flat fields (Plan Step 1b). Once Step 1c removes the flat
// fields, these tests become the primary contract for paint-property
// emission.

import { describe, it, expect } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from './lower'
import { emitCommands, type ShowCommand } from './emit-commands'

function compileFirstShow(src: string): ShowCommand {
  const tokens = new Lexer(src).tokenize()
  const ast = new Parser(tokens).parse()
  const scene = lower(ast)
  const cmds = emitCommands(scene)
  const show = cmds.shows[0]
  if (show === undefined) throw new Error('no show emitted')
  return show
}

describe('emit-commands paintShapes (Step 1b)', () => {
  it('constant opacity utility → paintShapes.common.opacity { constant }', () => {
    const show = compileFirstShow(`
      source s { type: geojson, url: "x.json" }
      layer a { source: s | opacity-60 }
    `)
    expect(show.paintShapes.common.opacity).toMatchObject({ kind: 'constant' })
    expect((show.paintShapes.common.opacity as { value: number }).value).toBeCloseTo(0.6, 2)
    // Dual-write invariant — legacy flat scalar still set.
    expect(show.opacity).toBeCloseTo(0.6, 2)
  })

  it('constant fill utility → paintShapes.fill.fill { constant, RGBA }', () => {
    const show = compileFirstShow(`
      source s { type: geojson, url: "x.json" }
      layer a { source: s | fill-red-500 }
    `)
    expect(show.paintShapes.fill.fill).toMatchObject({ kind: 'constant' })
    const rgba = (show.paintShapes.fill.fill as { value: readonly number[] }).value
    expect(rgba).toHaveLength(4)
  })

  it('constant stroke-width utility → paintShapes.line.strokeWidth { constant }', () => {
    const show = compileFirstShow(`
      source s { type: geojson, url: "x.json" }
      layer a { source: s | stroke-white stroke-4 }
    `)
    expect(show.paintShapes.line.strokeWidth).toEqual({ kind: 'constant', value: 4 })
  })

  it('layer with no fill → paintShapes.fill.fill = null', () => {
    const show = compileFirstShow(`
      source s { type: geojson, url: "x.json" }
      layer a { source: s | stroke-white stroke-1 }
    `)
    expect(show.paintShapes.fill.fill).toBeNull()
  })

  it('layer with no size authored → paintShapes.circle.size = null', () => {
    const show = compileFirstShow(`
      source s { type: geojson, url: "x.json" }
      layer a { source: s | fill-blue-500 }
    `)
    expect(show.paintShapes.circle.size).toBeNull()
  })

  it('zoom-interpolated opacity → paintShapes.common.opacity { zoom-interpolated }', () => {
    const show = compileFirstShow(`
      source s { type: geojson, url: "x.json" }
      layer a {
        source: s
        | opacity-[interpolate(zoom, 8, 40, 16, 100)]
      }
    `)
    expect(show.paintShapes.common.opacity.kind).toBe('zoom-interpolated')
    expect((show.paintShapes.common.opacity as { stops: unknown[] }).stops).toHaveLength(2)
  })
})
