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
  it('constant opacity utility → paintShapes.opacity { constant }', () => {
    const show = compileFirstShow(`
      source s { type: geojson, url: "x.json" }
      layer a { source: s | opacity-60 }
    `)
    expect(show.paintShapes.opacity).toMatchObject({ kind: 'constant' })
    expect((show.paintShapes.opacity as { value: number }).value).toBeCloseTo(0.6, 2)
    // Dual-write invariant — legacy flat scalar still set.
    expect(show.opacity).toBeCloseTo(0.6, 2)
  })

  it('constant fill utility → paintShapes.fill { constant, RGBA }', () => {
    const show = compileFirstShow(`
      source s { type: geojson, url: "x.json" }
      layer a { source: s | fill-red-500 }
    `)
    expect(show.paintShapes.fill).toMatchObject({ kind: 'constant' })
    const rgba = (show.paintShapes.fill as { value: readonly number[] }).value
    expect(rgba).toHaveLength(4)
  })

  it('constant stroke-width utility → paintShapes.strokeWidth { constant }', () => {
    const show = compileFirstShow(`
      source s { type: geojson, url: "x.json" }
      layer a { source: s | stroke-white stroke-4 }
    `)
    expect(show.paintShapes.strokeWidth).toEqual({ kind: 'constant', value: 4 })
  })

  it('layer with no fill → paintShapes.fill = null', () => {
    const show = compileFirstShow(`
      source s { type: geojson, url: "x.json" }
      layer a { source: s | stroke-white stroke-1 }
    `)
    expect(show.paintShapes.fill).toBeNull()
  })

  it('layer with no size authored → paintShapes.size = null', () => {
    const show = compileFirstShow(`
      source s { type: geojson, url: "x.json" }
      layer a { source: s | fill-blue-500 }
    `)
    expect(show.paintShapes.size).toBeNull()
  })

  it('zoom-interpolated opacity → paintShapes.opacity { zoom-interpolated }', () => {
    const show = compileFirstShow(`
      source s { type: geojson, url: "x.json" }
      layer a {
        source: s
        | opacity-[interpolate(zoom, 8, 40, 16, 100)]
      }
    `)
    expect(show.paintShapes.opacity.kind).toBe('zoom-interpolated')
    // Legacy zoomOpacityStops still populated (dual-write).
    expect(show.zoomOpacityStops).not.toBeNull()
    expect(show.zoomOpacityStops!.length).toBe(2)
  })
})
