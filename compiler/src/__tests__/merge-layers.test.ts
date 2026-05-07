import { describe, expect, it } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'
import { optimize } from '../ir/optimize'

function compileToScene(source: string) {
  const tokens = new Lexer(source).tokenize()
  const ast = new Parser(tokens).parse()
  const lowered = lower(ast)
  return optimize(lowered, ast)
}

describe('mergeLayers — IR auto-merge of same-source-layer xgis layers', () => {
  it('merges 3 contiguous landuse_* layers into 1 compound RenderNode', () => {
    const source = `
      source pm { type: pmtiles url: "x.pmtiles" }
      layer landuse_park {
        source: pm
        sourceLayer: "landuse"
        filter: .kind == "park"
        | fill-green-200 stroke-stone-300 stroke-0.3
      }
      layer landuse_grass {
        source: pm
        sourceLayer: "landuse"
        filter: .kind == "grass"
        | fill-lime-100 stroke-stone-300 stroke-0.3
      }
      layer landuse_residential {
        source: pm
        sourceLayer: "landuse"
        filter: .kind == "residential"
        | fill-stone-200 stroke-stone-300 stroke-0.3
      }
    `
    const scene = compileToScene(source)
    expect(scene.renderNodes.length).toBe(1)
    const merged = scene.renderNodes[0]
    expect(merged.sourceLayer).toBe('landuse')
    expect(merged.fill.kind).toBe('data-driven')
    expect(merged.filter).not.toBeNull()
  })

  it('does NOT merge across different sourceLayer', () => {
    const source = `
      source pm { type: pmtiles url: "x.pmtiles" }
      layer landuse_park {
        source: pm sourceLayer: "landuse" filter: .kind == "park"
        | fill-green-200
      }
      layer water {
        source: pm sourceLayer: "water"
        | fill-blue-500
      }
    `
    const scene = compileToScene(source)
    expect(scene.renderNodes.length).toBe(2)
  })

  it('does NOT merge layers that have no filter (would lose discard)', () => {
    const source = `
      source pm { type: pmtiles url: "x.pmtiles" }
      layer a { source: pm sourceLayer: "x" filter: .k == "p" | fill-red-500 }
      layer b { source: pm sourceLayer: "x" | fill-green-200 }
    `
    const scene = compileToScene(source)
    // Layer a alone isn't a group (need ≥ 2). Layer b has no filter
    // → can't merge. Result: both pass through.
    expect(scene.renderNodes.length).toBe(2)
  })

  it('does NOT merge when stroke widths differ (roads_* pattern)', () => {
    const source = `
      source pm { type: pmtiles url: "x.pmtiles" }
      layer minor {
        source: pm sourceLayer: "roads" filter: .kind == "minor_road"
        | stroke-stone-400 stroke-0.5
      }
      layer primary {
        source: pm sourceLayer: "roads" filter: .kind == "primary"
        | stroke-amber-300 stroke-2.5
      }
    `
    const scene = compileToScene(source)
    // Different widths → can't merge.
    expect(scene.renderNodes.length).toBe(2)
  })

  it('merges multi-value filter chains (||-joined kind tests)', () => {
    const source = `
      source pm { type: pmtiles url: "x.pmtiles" }
      layer parks {
        source: pm sourceLayer: "landuse"
        filter: .kind == "park" || .kind == "forest" || .kind == "wood"
        | fill-green-200 stroke-stone-300 stroke-0.3
      }
      layer grass {
        source: pm sourceLayer: "landuse"
        filter: .kind == "grass" || .kind == "meadow"
        | fill-lime-100 stroke-stone-300 stroke-0.3
      }
    `
    const scene = compileToScene(source)
    expect(scene.renderNodes.length).toBe(1)
    // Compound filter should be the OR of all values (5 values).
    const filterAst = scene.renderNodes[0].filter?.ast as { kind: string } | null
    expect(filterAst?.kind).toBe('BinaryExpr')
  })
})
