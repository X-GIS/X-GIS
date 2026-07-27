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

describe('coverage paint via a `style:` preset (#1272 E-②)', () => {
  it('a style:-referenced preset supplies ramp + range to a coverage layer', () => {
    const scene = compile(`
      preset s111_currents {
        ramp: "s111-speed"
        range: [0, 13]
      }
      source currents { type: coverage, url: "cbofs.h5" }
      layer speed { source: currents, style: s111_currents }
    `)
    const node = scene.renderNodes.find((n) => n.name === 'speed')!
    expect(node.ramp).toBe('s111-speed')
    expect(node.range).toEqual([0, 13])
  })

  it("the layer's own ramp/range OVERRIDE the preset's (layer wins)", () => {
    const scene = compile(`
      preset s111_currents {
        ramp: "s111-speed"
        range: [0, 13]
      }
      source currents { type: coverage, url: "cbofs.h5" }
      layer speed { source: currents, style: s111_currents, ramp: "viridis", range: [0, 2] }
    `)
    const node = scene.renderNodes.find((n) => n.name === 'speed')!
    expect(node.ramp).toBe('viridis')
    expect(node.range).toEqual([0, 2])
  })

  it('the preset can supply ONLY the ramp — the layer keeps its own range', () => {
    const scene = compile(`
      preset just_ramp { ramp: "s111-speed" }
      source currents { type: coverage, url: "cbofs.h5" }
      layer speed { source: currents, style: just_ramp, range: [0, 5] }
    `)
    const node = scene.renderNodes.find((n) => n.name === 'speed')!
    expect(node.ramp).toBe('s111-speed') // from the preset
    expect(node.range).toEqual([0, 5]) // the layer's own
  })

  it('a malformed range in the preset throws, naming the preset + layer', () => {
    expect(() =>
      compile(`
        preset bad { range: [0, 13, 20] }
        source cov { type: coverage, url: "x.h5" }
        layer c { source: cov, style: bad }
      `),
    ).toThrow(/preset "bad"[\s\S]*range[\s\S]*two-number/i)
  })

  it('a preset mixing paint AND a utility line lowers both without error', () => {
    // The preset carrying ramp/range must NOT regress the utility-inlining path:
    // both the block-property paint and the `|` line coexist in one preset.
    const scene = compile(`
      preset styled { ramp: "s111-speed" range: [0, 13] | opacity-70 }
      source currents { type: coverage, url: "cbofs.h5" }
      layer speed { source: currents, style: styled }
    `)
    const node = scene.renderNodes.find((n) => n.name === 'speed')!
    expect(node.ramp).toBe('s111-speed')
    expect(node.range).toEqual([0, 13])
  })
})

// ═══════════════════════════════════════════════════════════════════
// `| arrow` on a coverage layer — the declarative S-111 arrow portrayal (#1333)
// ═══════════════════════════════════════════════════════════════════
//
// The engine renders the official S-111 vector field when a coverage layer carries the
// `| arrow` modifier (#1302 grammar, reused). The compiler must lower `isArrow` onto the
// coverage ShowCommand exactly as for a point layer, coexisting with the ramp/range fill
// paint — the map arm keys the arrow field off `show.isArrow` (map.ts coverage block).

describe('coverage `| arrow` portrayal lowering (#1333)', () => {
  it('lowers `| arrow` on a coverage layer to isArrow, coexisting with ramp/range', () => {
    const scene = compile(`
      source currents { type: coverage, url: "cbofs.h5" }
      layer speed {
        source: currents
        ramp: "s111-speed"
        range: [0, 13]
        | arrow
      }
    `)
    const node = scene.renderNodes.find((n) => n.name === 'speed')!
    expect(node.isArrow).toBe(true)
    expect(node.ramp).toBe('s111-speed')
    expect(node.range).toEqual([0, 13])
  })

  it('threads isArrow onto the coverage ShowCommand (the arm reads show.isArrow)', () => {
    const scene = compile(`
      source currents { type: coverage, url: "cbofs.h5" }
      layer speed {
        source: currents
        ramp: "s111-speed"
        range: [0, 13]
        | arrow
      }
    `)
    const show = emitCommands(scene).shows.find((s) => s.targetName === 'currents')!
    expect(show.isArrow).toBe(true)
    expect(show.ramp).toBe('s111-speed')
    expect(show.range).toEqual([0, 13])
  })

  it('a `| arrow` coverage with NO ramp lowers to isArrow + undefined ramp (arrows-only arm)', () => {
    // The strict S-111 portrayal: the map arm skips the raster fill when isArrow && no ramp,
    // so a `| arrow` coverage without `ramp` must lower to exactly that (arrows, no fill).
    const scene = compile(`
      source currents { type: coverage, url: "cbofs.h5" }
      layer speed {
        source: currents
        | arrow
      }
    `)
    const node = scene.renderNodes.find((n) => n.name === 'speed')!
    expect(node.isArrow).toBe(true)
    expect(node.ramp).toBeUndefined()
    const show = emitCommands(scene).shows.find((s) => s.targetName === 'currents')!
    expect(show.isArrow).toBe(true)
    expect(show.ramp).toBeUndefined()
  })
})

// ═══════════════════════════════════════════════════════════════════
// `| particles` on a coverage layer — the ANIMATED S-111 portrayal (#1333)
// ═══════════════════════════════════════════════════════════════════
//
// The engine renders an animated particle-flow field when a coverage layer carries the
// `| particles` modifier — a second, moving reading of the same field `| arrow` draws
// statically. Mirrors the `| arrow` coverage lowering exactly (map.ts keys the field off
// `show.isParticles`); the two modifiers are independent and compose on the same layer.

describe('coverage `| particles` portrayal lowering (#1333)', () => {
  it('lowers `| particles` on a coverage layer to isParticles, coexisting with ramp/range', () => {
    const scene = compile(`
      source currents { type: coverage, url: "cbofs.h5" }
      layer speed {
        source: currents
        ramp: "s111-speed"
        range: [0, 13]
        | particles
      }
    `)
    const node = scene.renderNodes.find((n) => n.name === 'speed')!
    expect(node.isParticles).toBe(true)
    expect(node.ramp).toBe('s111-speed')
    expect(node.range).toEqual([0, 13])
  })

  it('threads isParticles onto the coverage ShowCommand (the arm reads show.isParticles)', () => {
    const scene = compile(`
      source currents { type: coverage, url: "cbofs.h5" }
      layer speed {
        source: currents
        | particles
      }
    `)
    const show = emitCommands(scene).shows.find((s) => s.targetName === 'currents')!
    expect(show.isParticles).toBe(true)
  })

  it('`| arrow | particles` together set BOTH markers — the two fields compose on one layer', () => {
    const scene = compile(`
      source currents { type: coverage, url: "cbofs.h5" }
      layer speed {
        source: currents
        | arrow
        | particles
      }
    `)
    const node = scene.renderNodes.find((n) => n.name === 'speed')!
    expect(node.isArrow).toBe(true)
    expect(node.isParticles).toBe(true)
  })

  it('a coverage layer with neither modifier leaves isParticles undefined', () => {
    const scene = compile(`
      source currents { type: coverage, url: "cbofs.h5" }
      layer speed {
        source: currents
        ramp: "viridis"
      }
    `)
    const node = scene.renderNodes.find((n) => n.name === 'speed')!
    expect(node.isParticles).toBeUndefined()
  })
})
