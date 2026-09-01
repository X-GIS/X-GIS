// ═══ #2121 — the live one-line `import "<style.json>"` drops `glyphs` ═══
//
// #1112 fixed this exact drop for `sprite` and stopped one field short. On the
// `import "url"` path the raw style JSON is fetched INSIDE `resolveImportsAsync`
// and consumed by the converter, so the host never sees `style.glyphs` to call
// `setGlyphsUrl` itself, and the converter deliberately omits it from the
// emitted DSL (`spec-coverage/top-level.ts:46-49` calls it a host concern).
//
// The consequence chain, measured on `?id=import_maplibre_mirror` before the
// fix (`glyphsUrl: null`, `hasPbf: false` at ready AND 8 s later): the runtime
// boots with `map.glyphsUrl === null` → `text/glyph-rasterizer-wiring.ts:49`
// takes the plain-Canvas2D case → `TextStage.pbfRasterizer` stays null → no
// `GlyphPbfCache` is ever constructed and no glyph range is ever fetched. Every
// style-import scene therefore draws its labels in SYSTEM FONTS instead of the
// style's own SDF fontstack — silently, and in fixtures that exist precisely to
// compare against MapLibre.
//
// These pin the compiler-side link: the collector is where the URL is lost.
// Reverting the `options.topLevel.glyphs = style.glyphs` write reds all four
// of the threading cases below.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import {
  resolveImports,
  resolveImportsAsync,
  type FileReader,
  type AsyncFileReader,
} from '../module/resolver'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'
import { TOP_LEVEL } from '../convert/spec-coverage/top-level'
import { withPragma } from './_pragma'

const GLYPHS_URL = '/vendor/demotiles-mirror/font/{fontstack}/{range}.pbf'
const SPRITE_URL = 'https://example.test/sprites/mirror'
const STYLE_URL = '/vendor/demotiles-mirror/style.json'

/** Shaped like the committed mirror style: a top-level `glyphs` template and
 *  a layer that actually draws text, so the URL is not decoration. */
const MIRROR_STYLE = {
  version: 8,
  name: 'Mirror',
  sprite: SPRITE_URL,
  glyphs: GLYPHS_URL,
  sources: {
    countries: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
  },
  layers: [
    {
      id: 'country-label',
      type: 'symbol',
      source: 'countries',
      layout: {
        'text-field': ['get', 'name'],
        'text-font': ['Open Sans Semibold'],
        'text-size': 12,
      },
      paint: { 'text-color': '#333' },
    },
  ],
}

const STYLE_JSON = JSON.stringify(MIRROR_STYLE)

function parse(source: string) {
  const tokens = new Lexer(withPragma(source)).tokenize()
  return new Parser(tokens).parse()
}

type Collector = { sprite?: string; glyphs?: string }

describe('#2121 — live-import glyphs URL surfacing', () => {
  it('PREMISE: the converter still emits a text-drawing layer, and still omits `glyphs` from the DSL', () => {
    // Both halves matter. If the layer stopped drawing text the collector tests
    // below would be about a URL nothing consumes; if the DSL started carrying
    // `glyphs` the collector would not be the only channel and this fix would
    // be the wrong one.
    const dsl = convertMapboxStyle(MIRROR_STYLE)
    expect(dsl, 'the symbol layer must still emit a label').toContain('label-')
    expect(dsl, '`glyphs` is a host concern and must not appear in the DSL').not.toContain(
      GLYPHS_URL,
    )
  })

  it('convertMapboxStyle surfaces the top-level glyphs URL into the topLevel collector', () => {
    // ROOT drop-point. Pre-fix the converter has no channel for `glyphs`, so
    // the collector stays empty.
    const topLevel: Collector = {}
    convertMapboxStyle(MIRROR_STYLE, { topLevel })
    expect(topLevel.glyphs).toBe(GLYPHS_URL)
  })

  it('…without disturbing the sprite field #1112 already carries', () => {
    const topLevel: Collector = {}
    convertMapboxStyle(MIRROR_STYLE, { topLevel })
    expect(topLevel.sprite, 'the #1112 wire must survive this change').toBe(SPRITE_URL)
  })

  it('resolveImports (sync) threads the imported style glyphs to the host collector', () => {
    const reader: FileReader = (path) => (path === STYLE_URL ? STYLE_JSON : null)
    const topLevel: Collector = {}
    resolveImports(parse(`import "${STYLE_URL}"`), './', reader, { topLevel })
    expect(topLevel.glyphs).toBe(GLYPHS_URL)
  })

  it('resolveImportsAsync (the runtime path) threads it too', async () => {
    // The exact path XGISMap.run() drives. What lands here is what the runtime
    // assigns to `this.glyphsUrl`, which label-pass.ts:329 reads when it builds
    // the lazy TextStage on the first label-bearing frame.
    const reader: AsyncFileReader = async (path) => (path === STYLE_URL ? STYLE_JSON : null)
    const topLevel: Collector = {}
    await resolveImportsAsync(parse(`import "${STYLE_URL}"`), './', reader, { topLevel })
    expect(topLevel.glyphs).toBe(GLYPHS_URL)
  })

  it('leaves the collector empty for a glyphless imported style (no false wire)', async () => {
    const { glyphs: _drop, ...glyphless } = MIRROR_STYLE
    const reader: AsyncFileReader = async (path) =>
      path === STYLE_URL ? JSON.stringify(glyphless) : null
    const topLevel: Collector = {}
    await resolveImportsAsync(parse(`import "${STYLE_URL}"`), './', reader, { topLevel })
    expect(topLevel.glyphs).toBeUndefined()
  })

  it('first write wins — a second imported style cannot clobber the first', async () => {
    // Mirrors the `sprite` contract (`=== undefined` guard). A style that
    // imports another style must not have the inner one's fontstack win.
    const topLevel: Collector = { glyphs: '/already/set/{fontstack}/{range}.pbf' }
    convertMapboxStyle(MIRROR_STYLE, { topLevel })
    expect(topLevel.glyphs).toBe('/already/set/{fontstack}/{range}.pbf')
  })
})

// ─── The guard against the THIRD field ──────────────────────────────────────
//
// `glyphs` is the second top-level field the converter declares host-forwarded
// and then fails to forward on this path. The two are not a coincidence: the
// coverage row is the only place the promise is written down, and nothing tied
// it to the collector that has to keep it. So tie them.
//
// The collector's shape is asserted from SOURCE text rather than from a type:
// the type is erased before vitest runs, and reflecting the object at runtime
// would only see the keys a given call happened to fill.

const CONVERTER_SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'convert', 'mapbox-to-xgis.ts'),
  'utf8',
)

/** The declared keys of `topLevel?: { … }` on ConvertMapboxStyleOptions. */
function collectorKeys(): string[] {
  const m = CONVERTER_SRC.match(/topLevel\?:\s*\{([^}]*)\}/)
  expect(m, 'ConvertMapboxStyleOptions must still declare a `topLevel` collector').not.toBeNull()
  return [...m![1]!.matchAll(/(\w+)\s*\?:/g)].map((k) => k[1]!)
}

describe('#2121 — every host-forwarded top-level field has a collector slot', () => {
  it('the coverage rows that promise a host setter are exactly the collector keys', () => {
    // A row earns its slot by NAMING the setter it is forwarded through
    // (`XGISMap.setSpriteUrl()` / `XGISMap.setGlyphsUrl()`), which is the form
    // both existing rows use. A future row that promises the same thing in
    // those words is caught; one that invents new phrasing is not, and that is
    // the honest limit of a prose-keyed gate — the alternative, a hand-kept
    // list here, is the second authority §12 warns about.
    const promised = TOP_LEVEL.filter((e) => /XGISMap\.set\w*Url\(/.test(e.note ?? '')).map(
      (e) => e.name,
    )
    expect(promised.length, 'the rows this gate stands on must exist').toBeGreaterThanOrEqual(2)
    expect(
      collectorKeys().sort(),
      `spec-coverage/top-level.ts promises the importer forwards ${JSON.stringify(promised)}, but the topLevel collector in mapbox-to-xgis.ts declares ${JSON.stringify(collectorKeys())} — on the \`import "url"\` path the collector IS the importer, so a promised field with no slot is silently dropped (#1112 for sprite, #2121 for glyphs)`,
    ).toEqual(promised.sort())
  })

  it('the converter actually WRITES every key it declares', () => {
    // A declared-but-never-written slot is the same silent drop one step later.
    for (const key of collectorKeys()) {
      expect(
        CONVERTER_SRC.includes(`options.topLevel.${key} = style.${key}`),
        `topLevel.${key} is declared but never written from style.${key}`,
      ).toBe(true)
    }
  })
})
