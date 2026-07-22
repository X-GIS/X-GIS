// ═══════════════════════════════════════════════════════════════════
// `coverage` LAYER paint (ramp/range) — IR lowering + ShowCommand threading
// ═══════════════════════════════════════════════════════════════════
//
// #1158 / #1272 / INC-D. The grammar + schema are pinned by schema/coverage-source.test.ts;
// this covers the LOWERING half the render wiring depends on:
//   • lowerLayer emits RenderNode.ramp / RenderNode.range from the LAYER block (a
//     `coverage` source is data-only — ramp/range are LAYER paint, the raster-color analogue)
//   • emitCommands threads both onto the ShowCommand (the runtime arms the
//     CoverageRenderer off the drawing layer's `SceneCommands.shows[i]`)
//   • a malformed `range` fails LOUDLY (a wrong window would recolour data)
//   • absent ramp/range leave the fields undefined (renderer defaults apply)

import { describe, expect, it } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'
import { optimize } from '../ir/optimize'
import { emitCommands } from '../ir/emit-commands'
import { withPragma } from './_pragma'

function compile(source: string) {
  const tokens = new Lexer(withPragma(source)).tokenize()
  const ast = new Parser(tokens).parse()
  return lower(ast)
}

describe('coverage LAYER ramp/range lowering (INC-D)', () => {
  it('lowerLayer emits RenderNode.ramp + RenderNode.range from the layer block', () => {
    const scene = compile(`
      source currents { type: coverage, url: "SEA_S111_2026.h5" }
      layer speed {
        source: currents
        ramp: "viridis"
        range: [0, 2]
      }
    `)
    const node = scene.renderNodes.find((n) => n.name === 'speed')!
    expect(node.ramp).toBe('viridis')
    expect(node.range).toEqual([0, 2])
    // The source stays DATA-ONLY (ramp/range are not source-level fields anymore).
    expect((scene.sources[0] as unknown as Record<string, unknown>).ramp).toBeUndefined()
  })

  it('a coverage layer with no ramp/range leaves both undefined (renderer defaults)', () => {
    const scene = compile(`
      source cov { type: coverage, url: "x.h5" }
      layer c { source: cov }
    `)
    const node = scene.renderNodes.find((n) => n.name === 'c')!
    expect(node.ramp).toBeUndefined()
    expect(node.range).toBeUndefined()
  })

  it('emitCommands threads ramp + range onto the ShowCommand', () => {
    const scene = compile(`
      source currents { type: coverage, url: "SEA_S111_2026.h5" }
      layer speed { source: currents, ramp: "viridis", range: [0, 2] }
    `)
    const show = emitCommands(scene).shows.find((s) => s.targetName === 'currents')
    expect(show).toBeDefined()
    expect(show!.ramp).toBe('viridis')
    expect(show!.range).toEqual([0, 2])
  })

  it('optimize() KEEPS the coverage load — a no-paint coverage layer is not DCE-pruned', () => {
    // The regression that shipped a "background-only" S-102/S-111 demo: a
    // coverage layer draws via the CoverageRenderer marker (its paint is the
    // ramp/range, not fill/stroke/label), so dead-layer-elim eliminated its
    // RenderNode and dead-source-elim then pruned the orphaned coverage source —
    // the `type: coverage` load vanished and the HDF5 was never fetched. This runs
    // the FULL optimize pipeline (both DCE passes) and pins the load's survival.
    const scene = compile(`
      source currents { type: coverage, url: "synthetic-currents.h5" }
      layer speed { source: currents, ramp: "viridis", range: [0, 2] }
    `)
    const cmds = emitCommands(optimize(scene))
    expect(cmds.loads).toHaveLength(1)
    expect(cmds.loads[0]!.name).toBe('currents')
    expect(cmds.loads[0]!.type).toBe('coverage')
  })

  it('a malformed range (wrong arity) throws a clear error naming the layer', () => {
    expect(() =>
      compile(`
        source cov { type: coverage, url: "x.h5" }
        layer c { source: cov, range: [0, 40, 80] }
      `),
    ).toThrow(/Layer[\s\S]*range[\s\S]*two-number/i)
  })

  it('a non-numeric range element throws (a string window is not a value window)', () => {
    expect(() =>
      compile(`
        source cov { type: coverage, url: "x.h5" }
        layer c { source: cov, range: ["lo", "hi"] }
      `),
    ).toThrow(/range[\s\S]*two-number/i)
  })
})
