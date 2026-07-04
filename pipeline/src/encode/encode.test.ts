import { describe, it, expect, vi } from 'vitest'
import { fromRows } from '../ingest'
import { where, groupBy } from '../transform'
import { join } from '../join'
import { seoulSigunguGazetteer } from '../gazetteer/kr'
import { bubble, points, odFlow, type PipelineSink, type PointPatch } from './index'

const sample = [
  { gu: '11680', hour: 8, out: 52000 },
  { gu: '11350', hour: 8, out: 41000 },
  { gu: '11710', hour: 8, out: 38000 },
]

describe('@xgis/pipeline · encode', () => {
  it('bubble emits a PointPatch (value + sqrt-scaled radius) and applies to the sink', () => {
    const t = fromRows(sample, { vintage: '2026' })
    const gaz = seoulSigunguGazetteer({ vintage: '2026' })
    const perGu = groupBy(where(join(t, { code: 'gu', gaz, as: 'o' }), { hour: 8 }), {
      by: ['o.lon', 'o.lat', 'gu'],
      agg: { out: 'sum' },
    })
    const result = bubble(perGu, { lon: 'o.lon', lat: 'o.lat', value: 'out' })
    expect(result.kind).toBe('points')

    let pushed: { id: string; patch: PointPatch } | null = null
    const sink: PipelineSink = {
      setSourcePoints: (id, patch) => {
        pushed = { id, patch }
      },
      setSourceData: () => {},
    }
    result.apply(sink, 'flows')
    expect(pushed).not.toBeNull()
    expect(pushed!.id).toBe('flows')
    expect(pushed!.patch.lon.length).toBe(perGu.length)
    const radius = pushed!.patch.properties!.radius as ArrayLike<number>
    for (let i = 0; i < radius.length; i++) {
      expect(radius[i]).toBeGreaterThanOrEqual(4)
      expect(radius[i]).toBeLessThanOrEqual(40)
    }
    for (let i = 0; i < pushed!.patch.lon.length; i++) {
      expect(pushed!.patch.lon[i]).toBeGreaterThan(126)
      expect(pushed!.patch.lon[i]).toBeLessThan(128)
    }
  })

  it('THROWS on projected (out-of-geographic-range) coordinates without a crs', () => {
    // EPSG:5179 UTM-K eastings/northings are ~10^6 — far outside lon/lat range.
    const t = fromRows([{ x: 953700, y: 1954500, v: 10 }], { vintage: '2026' })
    expect(() => bubble(t, { lon: 'x', lat: 'y', value: 'v' })).toThrow(
      /outside the .*geographic range/,
    )
  })

  it('points encoder emits bare points', () => {
    const t = fromRows([{ lon: 127, lat: 37.5 }], { vintage: '2026' })
    expect(points(t, { lon: 'lon', lat: 'lat' }).toFeatureCollection().features.length).toBe(1)
  })

  it('odFlow emits N LineString features with correct coordinates and weight property', () => {
    const gaz = seoulSigunguGazetteer({ vintage: '2026' })
    const rows = [
      { o_code: '11680', d_code: '11110', pop: 1000 },
      { o_code: '11350', d_code: '11200', pop: 500 },
    ]
    const t = fromRows(rows, { vintage: '2026' })
    const j = join(join(t, { code: 'o_code', gaz, as: 'origin' }), {
      code: 'd_code',
      gaz,
      as: 'dest',
    })
    const result = odFlow(j, { origin: 'origin', dest: 'dest', weight: 'pop' })

    expect(result.kind).toBe('fc')
    const fc = result.toFeatureCollection()
    expect(fc.features.length).toBe(2)

    for (const feat of fc.features as {
      type: string
      geometry: { type: string; coordinates: number[][] }
      properties: { weight: number; lift: number }
    }[]) {
      expect(feat.geometry.type).toBe('LineString')
      expect(feat.geometry.coordinates).toHaveLength(2)
      // Each endpoint has [lon, lat]
      expect(feat.geometry.coordinates[0]).toHaveLength(2)
      expect(feat.geometry.coordinates[1]).toHaveLength(2)
      // Endpoints in Seoul lon range
      expect(feat.geometry.coordinates[0]![0]).toBeGreaterThan(126)
      expect(feat.geometry.coordinates[0]![0]).toBeLessThan(128)
      expect(feat.geometry.coordinates[1]![0]).toBeGreaterThan(126)
      expect(feat.geometry.coordinates[1]![0]).toBeLessThan(128)
    }

    // weight property matches input pop values
    const weights = (
      fc.features as { properties: { weight: number } }[]
    ).map((f) => f.properties.weight)
    expect(weights).toContain(1000)
    expect(weights).toContain(500)

    // apply routes to setSourceData
    let called = false
    result.apply(
      {
        setSourcePoints: () => {},
        setSourceData: (_id, _fc) => {
          called = true
        },
      },
      'arcs',
    )
    expect(called).toBe(true)
  })

  it('odFlow on a zero-row (but typed) table emits an empty FeatureCollection (no throw)', () => {
    const gaz = seoulSigunguGazetteer({ vintage: '2026' })
    // A joined table filtered to zero rows — columns (origin.lon/dest.lon/pop) intact,
    // length 0. (fromRows([]) would have NO columns and throw in join — a different path.)
    const t = fromRows([{ o_code: '11680', d_code: '11110', pop: 1 }], { vintage: '2026' })
    const j = join(join(t, { code: 'o_code', gaz, as: 'origin' }), {
      code: 'd_code',
      gaz,
      as: 'dest',
    })
    const empty = where(j, { pop: 99999 }) // matches nothing → 0 rows, columns intact
    const fc = odFlow(empty, { origin: 'origin', dest: 'dest', weight: 'pop' }).toFeatureCollection()
    expect(fc.features.length).toBe(0)
  })

  it('odFlow keeps origin↔dest paired when the double-join drops partial rows', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const gaz = seoulSigunguGazetteer({ vintage: '2026' })
    // row0 both known; row1 unknown origin (dropped by join1); row2 unknown dest (dropped by join2).
    // Only row0 must survive, with its OWN origin+dest+weight — no half-joined misalignment.
    const rows = [
      { o_code: '11680', d_code: '11110', pop: 1000 }, // 강남→종로, both known
      { o_code: '99999', d_code: '11110', pop: 500 }, // unknown origin → dropped
      { o_code: '11350', d_code: '99999', pop: 300 }, // unknown dest → dropped
    ]
    const t = fromRows(rows, { vintage: '2026' })
    const j = join(join(t, { code: 'o_code', gaz, as: 'origin' }), {
      code: 'd_code',
      gaz,
      as: 'dest',
    })
    const fc = odFlow(j, { origin: 'origin', dest: 'dest', weight: 'pop' }).toFeatureCollection()
    expect(fc.features.length).toBe(1)
    const feat = fc.features[0] as { properties: { weight: number } }
    expect(feat.properties.weight).toBe(1000) // the surviving pair, correctly weighted
    warn.mockRestore()
  })
})
