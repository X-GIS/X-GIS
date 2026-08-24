// #2007 — item 1 (the hazard) + its warn-only siblings.
//
//   1. MapLibre multi-sprite ARRAY form: `"sprite": [{id,url}, …]` left
//      `options.topLevel.sprite` EMPTY (the collector only recognized
//      `typeof style.sprite === 'string'`) — every icon-image layer's
//      atlas silently failed to load, with ZERO warning. Fix: collect the
//      "default" entry (MapLibre's unprefixed-lookup id) into
//      topLevel.sprite; fall back to the first entry + say so when no
//      "default" exists; always warn about dropped extra ids, naming them
//      and the consequence; run every entry's url through the same
//      mapbox:// scheme check the string form gets (#1990); malformed
//      entries (no url string) warn + skip. String-form behaviour is
//      byte-identical (regression-guarded below).
//   2. `projection` / `state` / `font-faces` roots — same ignored-top-level
//      mechanism that already names fog/lights/terrain/sky/transition/
//      imports/models. Closes the asymmetry where the `["global-state"]`
//      EXPRESSION already fell through to the generic "Expression not
//      converted" warning but the `state` root that declares its
//      defaults was silently accepted.
//   3. Vector-source `promoteId` — genuinely unread end-to-end (the MVT
//      decoder reads only the tile's native wire-format id;
//      data/src/mvt-decoder.ts:61). GeoJSON `promoteId` already warns
//      (sources.ts, pinned by converter-warning-coverage.test.ts
//      "GeoJSON promoteId → reserved-id warning") — this closes the
//      vector-source half.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

function convert(style: unknown): {
  out: string
  warnings: string[]
  topLevel: { sprite?: string }
} {
  const warnings: string[] = []
  const topLevel: { sprite?: string } = {}
  const out = convertMapboxStyle(style as never, {
    coverage: { sources: [], layers: [], warnings },
    topLevel,
  })
  return { out, warnings, topLevel }
}

describe('#2007 — sprite array (the hazard)', () => {
  it('default + extra id → topLevel.sprite is the default url; warning names "extra"', () => {
    const { warnings, topLevel } = convert({
      version: 8,
      sprite: [
        { id: 'default', url: 'https://example.com/sprites/default' },
        { id: 'extra', url: 'https://example.com/sprites/extra' },
      ],
      sources: {},
      layers: [],
    })
    expect(topLevel.sprite).toBe('https://example.com/sprites/default')
    const dropped = warnings.find((w) => /extra id/i.test(w))
    expect(dropped, `expected an extra-id warning, got: ${JSON.stringify(warnings)}`).toBeDefined()
    expect(dropped).toContain('"extra"')
    expect(dropped).toContain('"extra:"') // the icon-image prefix consequence
    // no "default absent" warning — a default entry WAS present
    expect(warnings.find((w) => /no entry with id "default"/.test(w))).toBeUndefined()
  })

  it('no "default" id → first entry collected; warning says the default was absent', () => {
    const { warnings, topLevel } = convert({
      version: 8,
      sprite: [
        { id: 'a', url: 'https://example.com/sprites/a' },
        { id: 'b', url: 'https://example.com/sprites/b' },
      ],
      sources: {},
      layers: [],
    })
    expect(topLevel.sprite).toBe('https://example.com/sprites/a')
    const noDefault = warnings.find((w) => /no entry with id "default"/.test(w))
    expect(
      noDefault,
      `expected a no-default warning, got: ${JSON.stringify(warnings)}`,
    ).toBeDefined()
    expect(noDefault).toContain('"a"')
    const dropped = warnings.find((w) => /extra id/i.test(w))
    expect(dropped, `expected an extra-id warning, got: ${JSON.stringify(warnings)}`).toBeDefined()
    expect(dropped).toContain('"b"')
  })

  it('mapbox:// url on an array entry → the scheme warning fires for it', () => {
    const { warnings } = convert({
      version: 8,
      sprite: [{ id: 'default', url: 'mapbox://sprites/mapbox/streets-v8' }],
      sources: {},
      layers: [],
    })
    const hit = warnings.find((w) => /mapbox:\/\//.test(w))
    expect(
      hit,
      `expected a mapbox:// scheme warning, got: ${JSON.stringify(warnings)}`,
    ).toBeDefined()
    expect(hit).toContain('"default"')
    expect(hit).toContain('mapbox://sprites/mapbox/streets-v8')
  })

  it('malformed entry ({} / {id} without url) warns + skips; a later valid entry still collects', () => {
    const { warnings, topLevel } = convert({
      version: 8,
      sprite: [{}, { id: 'onlyId' }, { id: 'default', url: 'https://example.com/sprites/ok' }],
      sources: {},
      layers: [],
    })
    expect(topLevel.sprite).toBe('https://example.com/sprites/ok')
    const malformed = warnings.filter((w) => /has no valid "url" string/.test(w))
    expect(malformed.length, JSON.stringify(warnings)).toBe(2)
    expect(malformed[0]).toContain('index 0')
    expect(malformed[1]).toContain('index 1')
  })

  it('string sprite (regression guard) → byte-identical behaviour, zero new warnings', () => {
    const { warnings, topLevel, out } = convert({
      version: 8,
      sprite: 'https://example.com/sprite',
      sources: {},
      layers: [],
    })
    expect(topLevel.sprite).toBe('https://example.com/sprite')
    expect(warnings).toEqual([])
    expect(out).not.toContain('Conversion notes')
  })

  it('string sprite with mapbox:// scheme (regression guard) → unchanged single warning', () => {
    // Pins the pre-#2007 behaviour this PR must not touch: the string
    // branch is a completely separate code path from the new array branch.
    const { warnings, topLevel } = convert({
      version: 8,
      sprite: 'mapbox://sprites/mapbox/streets-v8',
      sources: {},
      layers: [],
    })
    expect(topLevel.sprite).toBe('mapbox://sprites/mapbox/streets-v8')
    expect(warnings.filter((w) => /mapbox:\/\//.test(w)).length).toBe(1)
  })
})

describe('#2007 — ignored top-level roots (projection / state / font-faces)', () => {
  it('a style authoring all three → each appears in the ignored-top-level warning', () => {
    const { warnings } = convert({
      version: 8,
      projection: { type: 'globe' },
      state: { theme: { default: 'light' } },
      'font-faces': [{ family: 'Test', data: 'data:font/woff2;base64,AA==' }],
      sources: {},
      layers: [],
    })
    const hit = warnings.find((w) => w.startsWith('Top-level style fields ignored:'))
    expect(
      hit,
      `expected the ignored-top-level warning, got: ${JSON.stringify(warnings)}`,
    ).toBeDefined()
    expect(hit).toContain('projection (host/runtime choice in X-GIS')
    expect(hit).toContain('state')
    expect(hit).toContain('font-faces')
  })

  it('none of the three present → no ignored-top-level warning (regression guard)', () => {
    const { warnings } = convert({
      version: 8,
      sources: {},
      layers: [],
    })
    expect(warnings.find((w) => w.startsWith('Top-level style fields ignored:'))).toBeUndefined()
  })
})

describe('#2007 — promoteId', () => {
  it('vector source promoteId → per-source warning naming the mis-key risk', () => {
    const { warnings } = convert({
      version: 8,
      sources: {
        v: { type: 'vector', url: 'https://example.com/tiles.json', promoteId: 'osm_id' },
      },
      layers: [],
    })
    const hit = warnings.find((w) => w.includes('"v"') && w.includes('promoteId'))
    expect(
      hit,
      `expected a vector promoteId warning, got: ${JSON.stringify(warnings)}`,
    ).toBeDefined()
    expect(hit).toContain('mis-key')
  })

  it('vector source without promoteId → no promoteId warning (regression guard)', () => {
    const { warnings } = convert({
      version: 8,
      sources: {
        v: { type: 'vector', url: 'https://example.com/tiles.json' },
      },
      layers: [],
    })
    expect(warnings.find((w) => w.includes('promoteId'))).toBeUndefined()
  })

  it('GeoJSON source promoteId → the existing warning still fires (pin, no code change)', () => {
    // Evidence verdict (see PR report): the runtime's fid-resolution paths
    // (id-resolver.ts / geojson-compile-worker.ts resolveIdResolver, and
    // the unwired geojsonvt/convert.ts promoteId branch) never consult
    // Mapbox promoteId for GeoJSON either — the existing sources.ts
    // warning is accurate as written. No new code for this case; this
    // test only pins that it still fires alongside the new vector one.
    const { warnings } = convert({
      version: 8,
      sources: {
        g: { type: 'geojson', data: 'https://example.com/d.geojson', promoteId: 'osm_id' },
      },
      layers: [],
    })
    const hit = warnings.find((w) => w.includes('"g"') && w.includes('promoteId'))
    expect(
      hit,
      `expected the existing GeoJSON promoteId warning, got: ${JSON.stringify(warnings)}`,
    ).toBeDefined()
  })
})
