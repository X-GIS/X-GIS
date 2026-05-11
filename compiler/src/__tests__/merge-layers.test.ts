import { describe, expect, it } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'
import { optimize } from '../ir/optimize'
import { emitCommands } from '../ir/emit-commands'

function compileToScene(source: string) {
  const tokens = new Lexer(source).tokenize()
  const ast = new Parser(tokens).parse()
  const lowered = lower(ast)
  return optimize(lowered, ast)
}

function compileToCommands(source: string) {
  const tokens = new Lexer(source).tokenize()
  const ast = new Parser(tokens).parse()
  const lowered = lower(ast)
  const optimized = optimize(lowered, ast)
  return emitCommands(optimized)
}

describe('shader-gen variant key disambiguation (29be5a0 regression guard)', () => {
  it('two compound match() layers on the same field get DIFFERENT variant keys', () => {
    // The bug: pre-29be5a0, buildKey collapsed every data-driven
    // fill to `f:feat|ff:kind` regardless of the actual match
    // arms. Two compound layers reading `.kind` (e.g. landuse
    // compound + roads compound) hashed to the SAME key →
    // shaderCache returned the FIRST compiled compound's pipeline
    // for the SECOND compound's draws → roads rendered with
    // landuse colour arms → every road feature failed every arm
    // → discarded. Fix: hash the synthesized match preambles into
    // the cache key.
    const source = `
      source pm { type: pmtiles url: "x.pmtiles" }
      layer landuse_park {
        source: pm sourceLayer: "landuse" filter: .kind == "park"
        | fill-green-200 stroke-stone-300 stroke-0.3
      }
      layer landuse_grass {
        source: pm sourceLayer: "landuse" filter: .kind == "grass"
        | fill-lime-100 stroke-stone-300 stroke-0.3
      }
      layer roads_minor {
        source: pm sourceLayer: "roads" filter: .kind == "minor_road"
        | stroke-stone-400 stroke-0.5
      }
      layer roads_primary {
        source: pm sourceLayer: "roads" filter: .kind == "primary"
        | stroke-amber-300 stroke-0.5
      }
    `
    const commands = compileToCommands(source)
    // 4 input → 2 compounds (landuse + roads).
    expect(commands.shows.length).toBe(2)
    const landuse = commands.shows.find(s => s.sourceLayer === 'landuse')
    const roads = commands.shows.find(s => s.sourceLayer === 'roads')
    expect(landuse?.shaderVariant).toBeDefined()
    expect(roads?.shaderVariant).toBeDefined()
    expect(landuse!.shaderVariant!.key).not.toBe(roads!.shaderVariant!.key)
  })

  it('two compounds with identical structural match keys (different arm tables) still differ', () => {
    // Same field, same featureFields, same arm count — only the
    // colour values differ. Pre-fix this collapsed to a single
    // cache entry; post-fix the matchArmsKey hash diverges.
    const source = `
      source pm { type: pmtiles url: "x.pmtiles" }
      layer a {
        source: pm sourceLayer: "x" filter: .kind == "p"
        | fill-green-200 stroke-stone-300 stroke-0.3
      }
      layer b {
        source: pm sourceLayer: "x" filter: .kind == "g"
        | fill-lime-100 stroke-stone-300 stroke-0.3
      }
      layer c {
        source: pm sourceLayer: "y" filter: .kind == "p"
        | fill-orange-100 stroke-stone-300 stroke-0.3
      }
      layer d {
        source: pm sourceLayer: "y" filter: .kind == "g"
        | fill-amber-200 stroke-stone-300 stroke-0.3
      }
    `
    const commands = compileToCommands(source)
    expect(commands.shows.length).toBe(2)
    const k1 = commands.shows[0].shaderVariant?.key
    const k2 = commands.shows[1].shaderVariant?.key
    expect(k1).toBeDefined()
    expect(k2).toBeDefined()
    expect(k1).not.toBe(k2)
  })

  it('identical match-arm tables on the same field produce IDENTICAL keys (pipeline can be shared)', () => {
    // Same arm values, different sourceLayers. The pipeline
    // doesn't care which source a feature came from — the shader
    // logic is identical, so cache reuse is correct here. Guards
    // against over-disambiguation.
    const source = `
      source pm { type: pmtiles url: "x.pmtiles" }
      layer a {
        source: pm sourceLayer: "x" filter: .kind == "p"
        | fill-green-200 stroke-stone-300 stroke-0.3
      }
      layer b {
        source: pm sourceLayer: "x" filter: .kind == "g"
        | fill-lime-100 stroke-stone-300 stroke-0.3
      }
      layer c {
        source: pm sourceLayer: "y" filter: .kind == "p"
        | fill-green-200 stroke-stone-300 stroke-0.3
      }
      layer d {
        source: pm sourceLayer: "y" filter: .kind == "g"
        | fill-lime-100 stroke-stone-300 stroke-0.3
      }
    `
    const commands = compileToCommands(source)
    expect(commands.shows.length).toBe(2)
    expect(commands.shows[0].shaderVariant?.key).toBe(commands.shows[1].shaderVariant?.key)
  })
})

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
    expect(scene.renderNodes[0].stroke.width.kind).toBe('per-feature')
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

  it('absorbs &&-chain != layer as the compound _ default arm', () => {
    // Mirrors the OSM-style landuse_other pattern.
    const source = `
      source pm { type: pmtiles url: "x.pmtiles" }
      layer landuse_park {
        source: pm sourceLayer: "landuse" filter: .kind == "park"
        | fill-green-200 stroke-stone-300 stroke-0.3
      }
      layer landuse_grass {
        source: pm sourceLayer: "landuse" filter: .kind == "grass"
        | fill-lime-100 stroke-stone-300 stroke-0.3
      }
      layer landuse_other {
        source: pm sourceLayer: "landuse"
        filter: .kind != "park" && .kind != "grass"
        | stroke-stone-300 stroke-0.2
      }
    `
    const scene = compileToScene(source)
    // Absorb landuse_other into the compound. Should be 1 RenderNode.
    expect(scene.renderNodes.length).toBe(1)
    const compound = scene.renderNodes[0]
    expect(compound.name).toMatch(/\+1default$/)
    // Filter dropped — the slice now accepts every source-layer
    // feature (the absorbed default arm renders ones the explicit
    // arms don't match).
    expect(compound.filter).toBeNull()
    // Width baked because landuse_other's stroke-0.2 differs from
    // the group's stroke-0.3.
    expect(compound.stroke.width.kind).toBe('per-feature')
  })

  it('does NOT absorb when != value set differs from || values', () => {
    // landuse_other filter excludes one MORE kind than the compound
    // covers — would render features on the kinds the compound
    // doesn't touch INCORRECTLY (different default rule). Don't
    // absorb in that case.
    const source = `
      source pm { type: pmtiles url: "x.pmtiles" }
      layer a { source: pm sourceLayer: "x" filter: .kind == "p"
        | fill-green-200 stroke-stone-300 stroke-0.3 }
      layer b { source: pm sourceLayer: "x" filter: .kind == "g"
        | fill-lime-100 stroke-stone-300 stroke-0.3 }
      layer c { source: pm sourceLayer: "x"
        filter: .kind != "p" && .kind != "g" && .kind != "extra"
        | stroke-stone-300 stroke-0.2 }
    `
    const scene = compileToScene(source)
    // Compound merges a+b → 1; layer c stays singleton because its
    // != set has 3 values vs the compound's 2 || values.
    expect(scene.renderNodes.length).toBe(2)
  })

  it('does NOT absorb when stroke shape differs (different cap)', () => {
    // strokesShapeEqual gate — even if value sets match, mismatched
    // cap / join / dash forces the candidate to stay separate.
    const source = `
      source pm { type: pmtiles url: "x.pmtiles" }
      layer a { source: pm sourceLayer: "x" filter: .kind == "p"
        | fill-green-200 stroke-stone-300 stroke-0.5 stroke-butt-cap }
      layer b { source: pm sourceLayer: "x" filter: .kind == "g"
        | fill-lime-100 stroke-stone-300 stroke-0.5 stroke-butt-cap }
      layer c { source: pm sourceLayer: "x"
        filter: .kind != "p" && .kind != "g"
        | stroke-stone-300 stroke-0.5 stroke-round-cap }
    `
    const scene = compileToScene(source)
    expect(scene.renderNodes.length).toBe(2)
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
    // Both should have synthesized colorExpr + per-feature width —
    // group members have different stroke colours AND widths.
    for (const r of roadsCompounds) {
      expect(r.stroke.colorExpr).toBeDefined()
      expect(r.stroke.width.kind).toBe('per-feature')
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
