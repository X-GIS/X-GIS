// #1303 — the built-in JSON field-mapping SourceLoader factory. Exercises the
// pure mapping logic (records-path traversal, lon/lat extraction in both
// supported shapes, property mapping/passthrough, malformed-record drop
// behavior) plus the fetch-path integration (HTTP / HTML-error-page / JSON-
// parse failures) a host's `ctx.fetch` can produce. No GPU, no XGISMap — the
// factory returns a plain `SourceLoader` function callable directly with a
// stub `SourceLoadContext`, matching how `source-load-outcome.test.ts` tests
// its extracted policy function in isolation.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { jsonFieldMappingLoader } from './json-field-mapping-loader'
import type { SourceLoadContext, LoaderFeatureCollection } from './source-loader'

/** Build a stub SourceLoadContext around a fixed response body. `fetchImpl`
 *  lets a test substitute its own (e.g. to return a non-JSON or HTML body)
 *  without touching the network. */
function ctx(
  body: unknown,
  init: { status?: number; contentType?: string; raw?: string } = {},
): SourceLoadContext {
  const text = init.raw ?? JSON.stringify(body)
  return {
    id: 'stations',
    url: 'https://example.com/stations.json',
    options: {},
    fetch: async () =>
      new Response(text, {
        status: init.status ?? 200,
        headers: init.contentType ? { 'content-type': init.contentType } : undefined,
      }),
  }
}

/** Unwrap the 'fc' branch of a SourceLoadResult (every success case here
 *  returns 'fc'), asserting the discriminant so a regression to 'points'
 *  fails loudly instead of reading `undefined.features`. */
function fc(result: { kind: string; data: unknown }): LoaderFeatureCollection {
  expect(result.kind).toBe('fc')
  return result.data as LoaderFeatureCollection
}

describe('jsonFieldMappingLoader (#1303) — construction-time mapping validation', () => {
  it('throws when neither {lon,lat} nor {coordinates} is given', () => {
    expect(() => jsonFieldMappingLoader({})).toThrow(/exactly one of/)
  })

  it('throws when BOTH {lon,lat} and {coordinates} are given', () => {
    expect(() =>
      jsonFieldMappingLoader({ lon: 'x', lat: 'y', coordinates: 'loc' }),
    ).toThrow(/exactly one of/)
  })

  it('throws when only lon is given (lat missing)', () => {
    expect(() => jsonFieldMappingLoader({ lon: 'x' })).toThrow(/'lon' and 'lat' must both be set/)
  })

  it('throws when only lat is given (lon missing)', () => {
    expect(() => jsonFieldMappingLoader({ lat: 'y' })).toThrow(/'lon' and 'lat' must both be set/)
  })

  it('does not throw for a valid {lon,lat} mapping', () => {
    expect(() => jsonFieldMappingLoader({ lon: 'x', lat: 'y' })).not.toThrow()
  })

  it('does not throw for a valid {coordinates} mapping', () => {
    expect(() => jsonFieldMappingLoader({ coordinates: 'loc' })).not.toThrow()
  })
})

describe('jsonFieldMappingLoader — records-path traversal', () => {
  it('resolves a nested recordsPath to the record array (the issue\'s `{ "data": [...] }` shape)', async () => {
    const loader = jsonFieldMappingLoader({ recordsPath: 'data', lon: 'lon', lat: 'lat' })
    const result = await loader(
      ctx({ data: [{ lon: 1, lat: 2 }, { lon: 3, lat: 4 }] }),
    )
    expect(fc(result).features.length).toBe(2)
  })

  it('treats the document root as the record array when recordsPath is omitted', async () => {
    const loader = jsonFieldMappingLoader({ lon: 'lon', lat: 'lat' })
    const result = await loader(ctx([{ lon: 1, lat: 2 }]))
    expect(fc(result).features.length).toBe(1)
  })

  it('throws naming the path when recordsPath resolves to a non-array', async () => {
    const loader = jsonFieldMappingLoader({ recordsPath: 'data', lon: 'lon', lat: 'lat' })
    await expect(loader(ctx({ data: { not: 'an array' } }))).rejects.toThrow(/"data".*object/)
  })

  it('throws naming "undefined" when recordsPath resolves to a missing key', async () => {
    const loader = jsonFieldMappingLoader({ recordsPath: 'missing', lon: 'lon', lat: 'lat' })
    await expect(loader(ctx({ data: [] }))).rejects.toThrow(/"missing".*undefined/)
  })

  it('throws naming the document root when recordsPath is omitted and the root is not an array', async () => {
    const loader = jsonFieldMappingLoader({ lon: 'lon', lat: 'lat' })
    await expect(loader(ctx({ data: [] }))).rejects.toThrow(/document root/)
  })
})

describe('jsonFieldMappingLoader — lon/lat extraction, separate fields', () => {
  it('maps numeric lon/lat fields to Point geometry', async () => {
    const loader = jsonFieldMappingLoader({ lon: 'longitude', lat: 'latitude' })
    const result = await loader(ctx([{ longitude: -76.013, latitude: 36.959 }]))
    const f = fc(result).features[0] as { geometry: { coordinates: number[] } }
    expect(f.geometry.coordinates).toEqual([-76.013, 36.959])
  })

  it('coerces numeric-STRING lon/lat fields (a REST API returning strings)', async () => {
    const loader = jsonFieldMappingLoader({ lon: 'lon', lat: 'lat' })
    const result = await loader(ctx([{ lon: '-76.013', lat: '36.959' }]))
    const f = fc(result).features[0] as { geometry: { coordinates: number[] } }
    expect(f.geometry.coordinates).toEqual([-76.013, 36.959])
  })

  it('supports a nested dot-path field (e.g. "position.lon")', async () => {
    const loader = jsonFieldMappingLoader({ lon: 'position.lon', lat: 'position.lat' })
    const result = await loader(ctx([{ position: { lon: 10, lat: 20 } }]))
    const f = fc(result).features[0] as { geometry: { coordinates: number[] } }
    expect(f.geometry.coordinates).toEqual([10, 20])
  })
})

describe('jsonFieldMappingLoader — lon/lat extraction, a single coordinates field', () => {
  it('maps a [lon, lat] array field to Point geometry', async () => {
    const loader = jsonFieldMappingLoader({ coordinates: 'loc' })
    const result = await loader(ctx([{ loc: [5, 6] }]))
    const f = fc(result).features[0] as { geometry: { coordinates: number[] } }
    expect(f.geometry.coordinates).toEqual([5, 6])
  })

  it('supports a nested dot-path to the coordinates array', async () => {
    const loader = jsonFieldMappingLoader({ coordinates: 'geo.loc' })
    const result = await loader(ctx([{ geo: { loc: ['7', '8'] } }]))
    const f = fc(result).features[0] as { geometry: { coordinates: number[] } }
    expect(f.geometry.coordinates).toEqual([7, 8])
  })
})

describe('jsonFieldMappingLoader — malformed per-record data is DROPPED, not propagated', () => {
  afterEach(() => vi.restoreAllMocks())

  it('drops a record missing the lon/lat field(s) and keeps the rest', async () => {
    const loader = jsonFieldMappingLoader({ lon: 'lon', lat: 'lat' })
    const result = await loader(ctx([{ lon: 1, lat: 2 }, { lon: 1 }, { lat: 2 }, {}]))
    expect(fc(result).features.length).toBe(1)
  })

  it('drops a record whose lon/lat is a non-numeric string (never emits NaN)', async () => {
    const loader = jsonFieldMappingLoader({ lon: 'lon', lat: 'lat' })
    const result = await loader(ctx([{ lon: 'not-a-number', lat: 2 }, { lon: 1, lat: 2 }]))
    const out = fc(result)
    expect(out.features.length).toBe(1)
    expect(
      (out.features as { geometry: { coordinates: number[] } }[]).some((f) =>
        f.geometry.coordinates.some((n) => Number.isNaN(n)),
      ),
    ).toBe(false)
  })

  it('drops a record whose lon/lat is the literal string "Infinity"', async () => {
    const loader = jsonFieldMappingLoader({ lon: 'lon', lat: 'lat' })
    const result = await loader(ctx([{ lon: 'Infinity', lat: 2 }, { lon: 1, lat: 2 }]))
    expect(fc(result).features.length).toBe(1)
  })

  it('drops a record whose lon/lat is an empty/blank string', async () => {
    const loader = jsonFieldMappingLoader({ lon: 'lon', lat: 'lat' })
    const result = await loader(ctx([{ lon: '  ', lat: 2 }, { lon: 1, lat: 2 }]))
    expect(fc(result).features.length).toBe(1)
  })

  it('drops a non-object record (null / number / string) inside the array', async () => {
    const loader = jsonFieldMappingLoader({ lon: 'lon', lat: 'lat' })
    const result = await loader(ctx([null, 42, 'x', { lon: 1, lat: 2 }]))
    expect(fc(result).features.length).toBe(1)
  })

  it('preserves record ORDER among the survivors when some are dropped', async () => {
    const loader = jsonFieldMappingLoader({ lon: 'lon', lat: 'lat', properties: { id: 'id' } })
    const result = await loader(
      ctx([{ id: 'a', lon: 1, lat: 1 }, { id: 'bad' }, { id: 'b', lon: 2, lat: 2 }]),
    )
    const out = fc(result).features as { properties: { id: string } }[]
    expect(out.map((f) => f.properties.id)).toEqual(['a', 'b'])
  })

  it('logs a console.warn naming the drop count when records are dropped', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const loader = jsonFieldMappingLoader({ lon: 'lon', lat: 'lat' })
    await loader(ctx([{ lon: 1, lat: 1 }, {}, {}]))
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toMatch(/dropped 2 of 3/)
  })

  it('does NOT log when nothing was dropped', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const loader = jsonFieldMappingLoader({ lon: 'lon', lat: 'lat' })
    await loader(ctx([{ lon: 1, lat: 1 }]))
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('jsonFieldMappingLoader — properties mapping', () => {
  it('maps only the specified output keys, dropping unmapped source fields (the issue\'s `props: { speed: .s, dir: .d }`)', async () => {
    const loader = jsonFieldMappingLoader({
      lon: 'lon',
      lat: 'lat',
      properties: { speed: 's', dir: 'd' },
    })
    const result = await loader(ctx([{ lon: 1, lat: 2, s: '34.5', d: '210', extra: 'unused' }]))
    const f = fc(result).features[0] as { properties: Record<string, unknown> }
    expect(f.properties).toEqual({ speed: '34.5', dir: '210' })
  })

  it('supports a nested dot-path in a property mapping', async () => {
    const loader = jsonFieldMappingLoader({
      lon: 'lon',
      lat: 'lat',
      properties: { name: 'meta.name' },
    })
    const result = await loader(ctx([{ lon: 1, lat: 2, meta: { name: 'Cape Henry' } }]))
    const f = fc(result).features[0] as { properties: Record<string, unknown> }
    expect(f.properties).toEqual({ name: 'Cape Henry' })
  })

  it('passes the whole record through as properties when `properties` is omitted', async () => {
    const loader = jsonFieldMappingLoader({ lon: 'lon', lat: 'lat' })
    const result = await loader(ctx([{ lon: 1, lat: 2, name: 'Cape Henry', speed: 34.5 }]))
    const f = fc(result).features[0] as { properties: Record<string, unknown> }
    expect(f.properties).toEqual({ lon: 1, lat: 2, name: 'Cape Henry', speed: 34.5 })
  })
})

describe('jsonFieldMappingLoader — fetch-path integration', () => {
  it('throws a descriptive error on HTTP non-ok', async () => {
    const loader = jsonFieldMappingLoader({ lon: 'lon', lat: 'lat' })
    await expect(loader(ctx([], { status: 500 }))).rejects.toThrow(/HTTP 500/)
  })

  it('throws when the response body is an HTML error page (200 + HTML, the SPA-fallback trap)', async () => {
    const loader = jsonFieldMappingLoader({ lon: 'lon', lat: 'lat' })
    await expect(
      loader(ctx(null, { raw: '<!doctype html><html><body>not found</body></html>' })),
    ).rejects.toThrow(/HTML document/)
  })

  it('throws when the response body does not parse as JSON', async () => {
    const loader = jsonFieldMappingLoader({ lon: 'lon', lat: 'lat' })
    await expect(loader(ctx(null, { raw: 'not json{' }))).rejects.toThrow(/did not parse as JSON/)
  })

  it('end-to-end: the NOAA CO-OPS-shaped document maps to a renderable FeatureCollection', async () => {
    const loader = jsonFieldMappingLoader({
      recordsPath: 'data',
      lon: 'longitude',
      lat: 'latitude',
      properties: { speed: 's', dir: 'd' },
    })
    const result = await loader(
      ctx({
        data: [
          { longitude: -76.013, latitude: 36.959, s: '34.5', d: '210' },
          { longitude: -76.134, latitude: 37.14, s: '12.1', d: '95' },
        ],
      }),
    )
    const out = fc(result)
    expect(out.type).toBe('FeatureCollection')
    expect(out.features.length).toBe(2)
    expect(out.features[0]).toEqual({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-76.013, 36.959] },
      properties: { speed: '34.5', dir: '210' },
    })
  })
})
