// ═══════════════════════════════════════════════════════════════════
// #1112 — oneway arrows never render in the live one-line import demo.
// ═══════════════════════════════════════════════════════════════════
//
// demo.html?id=openfreemap_bright loads a .xgis whose ONLY statement is
// `import "https://tiles.openfreemap.org/styles/bright"`. The runtime
// (XGISMap.run) resolves that import INTERNALLY — it fetches the raw
// style JSON and runs `convertMapboxStyle` inside `resolveImportsAsync`.
// The converter deliberately DROPS the style's top-level `sprite` URL
// (a host-integration concern: the host is expected to read it off the
// raw JSON and call `setSpriteUrl`). But on the `import "url"` path the
// raw JSON never surfaces to the host — it is fetched-and-consumed inside
// the compiler — so `spriteUrl` stays null, the lazy IconStage is never
// built (label-pass gate `host.spriteUrl !== null`), and `dispatchIcon`
// early-returns. EVERY icon-image layer (POI markers, highway shields,
// road_oneway arrows) renders nothing; the dense z16 oneway grids are
// merely the most conspicuous casualty.
//
// Fix: surface the imported style's top-level `sprite` URL through a
// `topLevel` out-collector on the convert options (mirrors the existing
// `inlineGeoJSON` collector), threaded through the module resolver, so
// the runtime can wire the sprite atlas the host can't otherwise see.
//
// These tests pin the compiler-side break (RED on pristine main, GREEN
// after the fix). They are the CPU repro of the FIRST link where the
// icon disappears — the sprite URL never reaching the runtime.

import { describe, expect, it } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import {
  resolveImports,
  resolveImportsAsync,
  type FileReader,
  type AsyncFileReader,
} from '../module/resolver'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'
import { withPragma } from './_pragma'

const SPRITE_URL = 'https://tiles.openfreemap.org/sprites/ofm_f384/ofm'
const STYLE_URL = 'https://tiles.openfreemap.org/styles/bright'

/** A minimal OpenFreeMap-"Bright"-shaped Mapbox style whose only drawing
 *  layer is `road_oneway` — the icon-only, text-less, along-path symbol
 *  layer from the issue (`icon-image: oneway`, `symbol-placement: line`,
 *  `symbol-spacing: 75`, zoom-interpolated `icon-size`, `icon-rotate: 90`,
 *  `icon-rotation-alignment: map`, `icon-opacity: 0.5`). Carries the
 *  top-level `sprite` URL the converter drops. */
const BRIGHT_STYLE = {
  version: 8,
  name: 'Bright',
  sprite: SPRITE_URL,
  glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
  sources: {
    openmaptiles: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' },
  },
  layers: [
    {
      id: 'road_oneway',
      type: 'symbol',
      source: 'openmaptiles',
      'source-layer': 'transportation',
      minzoom: 15,
      filter: ['==', 'oneway', 1],
      layout: {
        'symbol-placement': 'line',
        'symbol-spacing': 75,
        'icon-image': 'oneway',
        'icon-size': ['interpolate', ['linear'], ['zoom'], 15, 0.5, 19, 1],
        'icon-rotate': 90,
        'icon-rotation-alignment': 'map',
      },
      paint: { 'icon-opacity': 0.5 },
    },
  ],
}

const STYLE_JSON = JSON.stringify(BRIGHT_STYLE)

function parse(source: string) {
  const tokens = new Lexer(withPragma(source)).tokenize()
  return new Parser(tokens).parse()
}

describe('#1112 — live-import sprite URL surfacing', () => {
  it('PREMISE: the converter still emits the road_oneway along-path icon layer', () => {
    // The issue asserts the converter provably emits the layer; guard that so a
    // future converter regression can't make the sprite test vacuously pass.
    const dsl = convertMapboxStyle(BRIGHT_STYLE)
    expect(dsl).toContain('icon-image-oneway')
    expect(dsl).toContain('along-path')
    expect(dsl).toContain('spacing-75')
  })

  it('convertMapboxStyle surfaces the top-level sprite URL into the topLevel collector', () => {
    // ROOT drop-point. Pre-fix the converter has no channel for `sprite`
    // (it is intentionally omitted from the emitted DSL) so the collector
    // stays empty — RED. The fix writes style.sprite here.
    const topLevel: { sprite?: string } = {}
    convertMapboxStyle(BRIGHT_STYLE, { topLevel })
    expect(topLevel.sprite).toBe(SPRITE_URL)
  })

  it('resolveImports (sync) threads the imported style sprite to the host collector', () => {
    // The live `import "url"` path: a mock reader returns the raw Mapbox
    // style JSON for the imported URL. Pre-fix, the sprite is dropped inside
    // the converter and never reaches the host — RED.
    const reader: FileReader = (path) => (path === STYLE_URL ? STYLE_JSON : null)
    const program = parse(`import "${STYLE_URL}"`)
    const topLevel: { sprite?: string } = {}
    resolveImports(program, './', reader, { topLevel })
    expect(topLevel.sprite).toBe(SPRITE_URL)
  })

  it('resolveImportsAsync (runtime path) threads the imported style sprite to the host collector', async () => {
    // The exact path XGISMap.run() drives (map.ts resolveImportsAsync). The
    // captured URL is what the runtime assigns to `this.spriteUrl` so the
    // lazy IconStage builds and road_oneway arrows resolve their sprite.
    const reader: AsyncFileReader = async (path) => (path === STYLE_URL ? STYLE_JSON : null)
    const program = parse(`import "${STYLE_URL}"`)
    const topLevel: { sprite?: string } = {}
    await resolveImportsAsync(program, './', reader, { topLevel })
    expect(topLevel.sprite).toBe(SPRITE_URL)
  })

  it('leaves the collector empty for a spriteless imported style (no false wire)', async () => {
    const { sprite: _drop, ...spriteless } = BRIGHT_STYLE
    const reader: AsyncFileReader = async (path) =>
      path === STYLE_URL ? JSON.stringify(spriteless) : null
    const program = parse(`import "${STYLE_URL}"`)
    const topLevel: { sprite?: string } = {}
    await resolveImportsAsync(program, './', reader, { topLevel })
    expect(topLevel.sprite).toBeUndefined()
  })
})
