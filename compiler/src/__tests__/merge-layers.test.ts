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

  it('OSM-style demo end-to-end — measures realistic fold ratio', () => {
    // Mirrors the structure of `playground/src/examples/osm-style.xgis`:
    // 6 landuse_* fold to 1, 5 roads_* keep separate (stroke widths
    // differ), water + buildings stay as-is. Expected output: 8 nodes
    // (1 + 5 + 1 + 1) down from 13.
    const source = `
      source pm { type: pmtiles url: "x.pmtiles" }
      layer landuse_park {
        source: pm sourceLayer: "landuse"
        filter: .kind == "park" || .kind == "forest"
        | fill-green-200 stroke-green-300 stroke-0.3
      }
      layer landuse_grass {
        source: pm sourceLayer: "landuse"
        filter: .kind == "grass" || .kind == "meadow"
        | fill-lime-100 stroke-lime-200 stroke-0.3
      }
      layer landuse_residential {
        source: pm sourceLayer: "landuse"
        filter: .kind == "residential"
        | fill-stone-200 stroke-stone-300 stroke-0.3
      }
      layer landuse_commercial {
        source: pm sourceLayer: "landuse"
        filter: .kind == "commercial"
        | fill-orange-100 stroke-orange-200 stroke-0.3
      }
      layer landuse_industrial {
        source: pm sourceLayer: "landuse"
        filter: .kind == "industrial"
        | fill-zinc-200 stroke-zinc-300 stroke-0.3
      }
      layer water {
        source: pm sourceLayer: "water"
        | fill-sky-300 stroke-sky-500 stroke-0.5
      }
      layer roads_minor {
        source: pm sourceLayer: "roads"
        filter: .kind == "minor_road"
        | stroke-stone-400 stroke-0.5
      }
      layer roads_primary {
        source: pm sourceLayer: "roads"
        filter: .kind == "primary"
        | stroke-amber-300 stroke-2.5
      }
      layer roads_highway {
        source: pm sourceLayer: "roads"
        filter: .kind == "highway"
        | stroke-orange-400 stroke-3.5
      }
      layer buildings {
        source: pm sourceLayer: "buildings"
        | fill-stone-300 stroke-stone-500 stroke-0.5
      }
    `
    const scene = compileToScene(source)
    // 5 landuse_* fold to 1, water + 3 roads_* (different widths) +
    // buildings = 6 RenderNodes total (down from 10 input).
    expect(scene.renderNodes.length).toBe(6)
    // The compound landuse should reference sourceLayer "landuse"
    // and have a data-driven fill (the synthesized match).
    const landuse = scene.renderNodes.find(n => n.sourceLayer === 'landuse')
    expect(landuse?.fill.kind).toBe('data-driven')
    expect(landuse?.stroke.color.kind).toBe('data-driven')
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
