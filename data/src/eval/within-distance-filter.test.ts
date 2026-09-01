// Regression: a vector-tile slice filter must see the feature GEOMETRY.
//
// Mapbox `["within", poly]` and `["distance", target]` lower to
// `within(get("$geometry"), …)` / `distance(get("$geometry"), …)`
// (convert/expr-lookup.ts). The GeoJSON path injects `$geometry`
// (map/src/feature-helpers.ts applyFilter); the two vector-tile
// slice-filter call sites — the MVT worker and the PMTiles inline
// compiler — built their props bag WITHOUT it, so the containment test
// saw no geometry and returned false, the distance builtin returned
// null, and the layer drew ZERO features. Silently: a lowered filter
// warns nowhere, so neither the converter nor the runtime said a word.
//
// Both call sites now route through ONE authority, `sliceFilterAccepts`,
// which owns the bag. The blocks below drive THAT function — which is the
// behaviour, but NOT the wiring: re-inlining the pre-fix bag at either call
// site restores the bug and leaves every behavioural assertion here green,
// because neither call site is ever loaded. The SINGLE AUTHORITY block at the
// bottom is what closes that hole, and it is the reason the extraction is the
// fix rather than patching two copies.
//
// Ordering is deliberate (CLAUDE.md §12, "assert the CAUSE before the
// EFFECT"): the first block probes ONLY that `$geometry` reaches the
// bag and contains no containment or distance arithmetic at all, so
// severing the injection reddens a message that names the injection,
// while a broken ray-cast / ruler leaves it green and reddens only the
// outcome blocks. The last block is the negative control: a filter that
// needs no geometry must keep working under either cut.
//
// Correct-by-construction for the shipped Point/MultiPoint slice: MVT
// clipping + buffering cannot move a point's lng/lat, so evaluating a
// per-tile fragment answers the same as evaluating the whole feature.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import {
  Lexer,
  Parser,
  lower,
  emitCommands,
  convertMapboxStyle,
  XGIS_LANGUAGE_MAJOR,
  type GeoJSONFeature,
} from '@xgis/compiler'
import { sliceFilterAccepts } from './filter-eval'

/** The zoom the worker passes as `cameraZoom` (mvt-worker `msg.z`,
 *  pmtiles-backend `z`). Irrelevant to these filters; pinned so the bag
 *  is shaped exactly like the production one. */
const TILE_Z = 14

/** Decoded-MVT feature shape. mvt-decoder.ts un-quantizes every
 *  coordinate to lng/lat (`f.toGeoJSON(x, y, z)`) before any consumer
 *  sees a feature, so this is literally what the worker filters — the
 *  same space `within`'s polygon and `distance`'s target are emitted in.
 *  No reprojection is owed anywhere on this path. */
const pointAt = (lon: number, lat: number, name: string): GeoJSONFeature =>
  ({
    type: 'Feature',
    id: 7,
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: { name },
  }) as unknown as GeoJSONFeature

/** Inside the 0..2 test square, ~157 km from [0, 0]. */
const INSIDE = pointAt(1, 1, 'inside')
/** Outside the square, ~783 km from [0, 0]. */
const OUTSIDE = pointAt(5, 5, 'outside')

const CORPUS: ReadonlyArray<readonly [string, GeoJSONFeature]> = [
  ['inside', INSIDE],
  ['outside', OUTSIDE],
]

const keptBy = (ast: unknown): string[] =>
  CORPUS.filter(([, f]) => sliceFilterAccepts(ast, f, TILE_Z)).map(([n]) => n)

interface ShowLike {
  name?: string
  sourceLayer?: string
  filterExpr: { ast: unknown } | null
}

function showsOf(xgis: string): ShowLike[] {
  const tokens = new Lexer(xgis).tokenize()
  return emitCommands(lower(new Parser(tokens).parse())).shows as unknown as ShowLike[]
}

/** One MVT-source layer carrying `filter`, through the REAL converter —
 *  so the AST under test is the one a converted Mapbox style ships. */
function mvtFilterAst(filter: unknown): unknown {
  const style = {
    version: 8,
    sources: { openmaptiles: { type: 'vector', url: 'https://example/planet' } },
    layers: [
      {
        id: 'poi_filtered',
        type: 'circle',
        source: 'openmaptiles',
        'source-layer': 'poi',
        filter,
      },
    ],
  }
  const shows = showsOf(convertMapboxStyle(style as never))
  expect(shows.length, 'converter emitted no show for the filtered layer').toBe(1)
  const ast = shows[0]!.filterExpr?.ast
  expect(ast, 'converter dropped the filter (show has no filterExpr)').toBeTruthy()
  return ast
}

describe('vector-tile slice filter — $geometry reaches the props bag (CAUSE)', () => {
  // Pure mechanism probe: `get("$geometry") != null` is the shape the
  // converter emits for `["has", …]` on a `$`-prefixed key, and it
  // touches NO containment or distance arithmetic. True iff the
  // slice-filter bag carries the feature geometry.
  const ast = showsOf(
    `xgis ${XGIS_LANGUAGE_MAJOR}\n` +
      'source openmaptiles { type: pmtiles, url: "x.pmtiles" }\n' +
      'layer geometry_probe {\n' +
      '  source: openmaptiles\n' +
      '  sourceLayer: "poi"\n' +
      '  filter: get("$geometry") != null\n' +
      '  | label-[.name]\n' +
      '}\n',
  )[0]!.filterExpr!.ast

  it('the bag sliceFilterAccepts builds carries the feature geometry', () => {
    expect(
      sliceFilterAccepts(ast, INSIDE, TILE_Z),
      'the vector-tile slice-filter props bag carries NO $geometry — within()/distance() cannot see the feature',
    ).toBe(true)
  })
})

describe('["within"] filter on an MVT source (EFFECT)', () => {
  const SQUARE = {
    type: 'Polygon',
    coordinates: [
      [
        [0, 0],
        [2, 0],
        [2, 2],
        [0, 2],
        [0, 0],
      ],
    ],
  }
  const ast = mvtFilterAst(['within', SQUARE])

  it('keeps exactly the feature inside the polygon', () => {
    expect(keptBy(ast)).toEqual(['inside'])
  })
})

describe('["distance"] filter on an MVT source (EFFECT)', () => {
  // 200 km threshold separates the ~157 km and ~783 km features.
  const ast = mvtFilterAst(['<', ['distance', { type: 'Point', coordinates: [0, 0] }], 200_000])

  it('keeps exactly the feature inside the radius', () => {
    expect(keptBy(ast)).toEqual(['inside'])
  })
})

describe('negative control — a geometry-free filter is unaffected', () => {
  const ast = mvtFilterAst(['==', ['get', 'name'], 'inside'])

  it('a property filter still routes on properties alone', () => {
    expect(keptBy(ast)).toEqual(['inside'])
  })
})

// ─────────────────────────────────────────────────────────────────────
// SINGLE AUTHORITY — the wiring, not the behaviour.
//
// Every block above calls `sliceFilterAccepts` directly, so none of them
// can see the two production call sites. That matters: the bug this file
// exists for lived AT those call sites, each carrying its own hand-built
// bag, and the fix is that neither builds one any more. Restoring either
// copy leaves all four assertions above green.
//
// So assert the property the fix actually rests on: within `data/src`,
// the slice-filter props bag has exactly ONE builder. `evalFilterExpr` is
// the function a hand-built bag is fed to, so requiring that no
// production module outside `filter-eval.ts` calls it pins the shape of
// the regression rather than a symptom of it. Tests may call it freely —
// several do, and they are not the wiring.
// ─────────────────────────────────────────────────────────────────────
describe('single authority — no second props bag under data/src', () => {
  const OWNER = 'data/src/eval/filter-eval.ts'

  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = join(dir, e.name)
      if (e.isDirectory()) return e.name === 'node_modules' ? [] : sources(full)
      return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [full] : []
    })

  it('only filter-eval.ts feeds evalFilterExpr — a re-inlined bag at a call site fails here', () => {
    const root = fileURLToPath(new URL('../..', import.meta.url)) // data/
    const offenders = sources(join(root, 'src'))
      .map((f) => [f.slice(f.indexOf('data/src')), readFileSync(f, 'utf8')] as const)
      .filter(([rel]) => rel !== OWNER)
      .filter(([, src]) => /\bevalFilterExpr\b/.test(src))
      .map(([rel]) => rel)

    expect(
      offenders,
      `these modules build their own filter props bag instead of routing through ` +
        `sliceFilterAccepts (${OWNER}). That is exactly the drift this PR removed: ` +
        `each hand-built bag omitted \`geometry:\`, so every ["within"] / ["distance"] ` +
        `filter on a vector-tile source silently kept ZERO features.\n  ` +
        offenders.join('\n  '),
    ).toEqual([])
  })

  it('and both call sites do route through it — so the check above is not vacuous', () => {
    const root = fileURLToPath(new URL('../..', import.meta.url))
    for (const rel of ['src/workers/mvt-worker.ts', 'src/sources/pmtiles-backend.ts']) {
      const routed = readFileSync(join(root, rel), 'utf8').includes('sliceFilterAccepts(')
      // Boolean, not `toContain` on the source: a failing `toContain` prints the
      // whole module and buries the one line that names the cause.
      expect(routed, `${rel} no longer routes its slice filter through sliceFilterAccepts`).toBe(
        true,
      )
    }
  })
})
