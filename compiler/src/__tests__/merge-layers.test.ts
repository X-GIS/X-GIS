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

  it('merges stroke-colour-AND-width-differing layers via baked segment override', () => {
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
    expect(scene.renderNodes.length).toBe(1)
    expect(scene.renderNodes[0].stroke.widthExpr).toBeDefined()
    expect(scene.renderNodes[0].stroke.colorExpr).toBeDefined()
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
    // 5 landuse_* fold to 1, water single, 3 roads_* fold to 1
    // (per-feature widthExpr + colorExpr both baked into segment
    // buffer at decode time), buildings single = 4 RenderNodes.
    expect(scene.renderNodes.length).toBe(4)
  })

  it('merges only when stroke colours match across the group', () => {
    const source = `
      source pm { type: pmtiles url: "x.pmtiles" }
      layer a { source: pm sourceLayer: "x" filter: .k == "p"
        | fill-green-200 stroke-stone-300 stroke-0.5 }
      layer b { source: pm sourceLayer: "x" filter: .k == "g"
        | fill-lime-100 stroke-stone-300 stroke-0.5 }
    `
    const scene = compileToScene(source)
    // Same stroke colour — these fold into 1 compound.
    expect(scene.renderNodes.length).toBe(1)
    expect(scene.renderNodes[0].fill.kind).toBe('data-driven')
    // Stroke colour stays constant (= the shared colour) since the
    // strokeColorsEqual gate succeeded; no need to synthesise a
    // match.
    expect(scene.renderNodes[0].stroke.color.kind).toBe('constant')
  })

  it('non-contiguous same-sourceLayer groups produce SEPARATE compounds', () => {
    // Two roads_* groups separated by a non-mergeable layer
    // (different sourceLayer in between). Each group should fold
    // into its own compound — the runtime keys segment overrides
    // by sliceKey, so the two compounds get distinct slices and
    // their stroke widths / colours don't bleed across each other.
    const source = `
      source pm { type: pmtiles url: "x.pmtiles" }
      layer roads_a {
        source: pm sourceLayer: "roads" filter: .kind == "minor_road"
        | stroke-stone-400 stroke-0.5
      }
      layer roads_b {
        source: pm sourceLayer: "roads" filter: .kind == "primary"
        | stroke-amber-300 stroke-2.5
      }
      layer water {
        source: pm sourceLayer: "water"
        | fill-sky-300 stroke-sky-500 stroke-0.5
      }
      layer roads_c {
        source: pm sourceLayer: "roads" filter: .kind == "highway"
        | stroke-orange-400 stroke-3.5
      }
      layer roads_d {
        source: pm sourceLayer: "roads" filter: .kind == "rail"
        | stroke-slate-500 stroke-1
      }
    `
    const scene = compileToScene(source)
    // Expect: 1 roads compound (a+b), 1 water, 1 roads compound
    // (c+d) — the water break splits the roads group into two
    // contiguous runs. 5 input → 3 output.
    expect(scene.renderNodes.length).toBe(3)
    const roadsCompounds = scene.renderNodes.filter(n => n.sourceLayer === 'roads')
    expect(roadsCompounds.length).toBe(2)
    // Both should have synthesized colorExpr + widthExpr — group
    // members have different stroke colours AND widths.
    for (const r of roadsCompounds) {
      expect(r.stroke.colorExpr).toBeDefined()
      expect(r.stroke.widthExpr).toBeDefined()
    }
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
