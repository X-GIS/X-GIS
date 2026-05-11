// Data-driven diagnostic for the user-reported x6 label submission
// count near Seoul. If filters work correctly, a Seoul-shaped feature
// (class=city, capital=2) should match EXACTLY ONE OFM Bright place
// show (label_city_capital). A baseline of 6 submissions per anchor
// means either (a) all 6 shows are matching every feature — a filter
// eval bug — or (b) data density genuinely puts 6 features near every
// anchor.
//
// This test asks the runtime's actual filter pipeline (compiler lower
// + ShowCommand mapping in emit-commands + filter-eval) to compute
// which OFM Bright place shows match a Seoul feature, with no manual
// AST stubbing.

import { describe, it, expect } from 'vitest'
import { Lexer } from '@xgis/compiler'
import { Parser } from '@xgis/compiler'
import { lower } from '@xgis/compiler'
import { emitCommands } from '@xgis/compiler'
import { optimize } from '@xgis/compiler'
import { evalFilterExpr } from './filter-eval'

// Minimal OFM Bright place layer set — same filters as
// fixtures/openfreemap-bright.json but inlined so the test is local.
const OFM_BRIGHT_PLACE_SUBSET_XGIS = `
source openmaptiles { type: pmtiles, url: "x.pmtiles" }

layer label_other {
  source: openmaptiles
  sourceLayer: "place"
  minzoom: 8
  filter: .class != "city" && .class != "continent" && .class != "country" && .class != "state" && .class != "town" && .class != "village"
  | label-[.name]
}
layer label_village {
  source: openmaptiles
  sourceLayer: "place"
  minzoom: 9
  filter: .class == "village"
  | label-[.name]
}
layer label_town {
  source: openmaptiles
  sourceLayer: "place"
  minzoom: 6
  filter: .class == "town"
  | label-[.name]
}
layer label_city {
  source: openmaptiles
  sourceLayer: "place"
  minzoom: 3
  filter: (.class == "city") && (.capital != 2)
  | label-[.name]
}
layer label_city_capital {
  source: openmaptiles
  sourceLayer: "place"
  minzoom: 3
  filter: (.class == "city") && (.capital == 2)
  | label-[.name]
}
`

interface ShowLike { targetName: string; filterExpr: { ast: unknown } | null }

function buildShows(): ShowLike[] {
  const tokens = new Lexer(OFM_BRIGHT_PLACE_SUBSET_XGIS).tokenize()
  const ast = new Parser(tokens).parse()
  const scene = lower(ast)
  const cmds = emitCommands(optimize(scene, ast))
  return cmds.shows as unknown as ShowLike[]
}

describe('OFM Bright place filter routing — should match exactly ONE show per feature', () => {
  const shows = buildShows()

  it('Seoul (class=city, capital=2) matches exactly one show', () => {
    const seoul = { class: 'city', capital: 2, name: 'Seoul' }
    const matched = shows.filter(s => s.filterExpr ? evalFilterExpr(s.filterExpr.ast, seoul) : true)
    expect(matched.length).toBe(1)
  })

  it('Busan (class=city, capital≠2) matches exactly one show', () => {
    const busan = { class: 'city', capital: 0, name: 'Busan' }
    const matched = shows.filter(s => s.filterExpr ? evalFilterExpr(s.filterExpr.ast, busan) : true)
    expect(matched.length).toBe(1)
  })

  it('A town (class=town) matches exactly one show', () => {
    const town = { class: 'town', name: 'X' }
    const matched = shows.filter(s => s.filterExpr ? evalFilterExpr(s.filterExpr.ast, town) : true)
    expect(matched.length).toBe(1)
  })

  it('A suburb (class=suburb) matches exactly one show', () => {
    const suburb = { class: 'suburb', name: 'X' }
    const matched = shows.filter(s => s.filterExpr ? evalFilterExpr(s.filterExpr.ast, suburb) : true)
    expect(matched.length).toBe(1)
  })

  it('SANITY: filterExpr is actually set on shows (regression for IR field name)', () => {
    for (const s of shows) {
      // Every show in OFM Bright has a filter. If filterExpr is undefined
      // for any of them, the lower → emit-commands mapping is broken
      // and every label show would match every feature in its
      // source-layer (the user-reported x6 baseline).
      expect(s.filterExpr, `${s.name} missing filterExpr`).toBeTruthy()
      expect(s.filterExpr!.ast).toBeTruthy()
    }
  })
})
