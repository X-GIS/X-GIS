import { describe, it, expect } from 'vitest'
import { fromRows } from '../ingest'
import { where, groupBy } from '../transform'
import { join } from '../join'
import { seoulSigunguGazetteer } from '../gazetteer/kr'
import { bubble, points, type PipelineSink, type PointPatch } from './index'

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
})
