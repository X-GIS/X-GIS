import { describe, it, expect } from 'vitest'
import { fromRows } from './ingest'
import { where, groupBy } from './transform'
import { join } from './join'
import { seoulSigunguGazetteer } from './gazetteer/kr'
import { bubble, type EncodeResult, type PipelineSink, type PointPatch } from './encode'
import { load } from './load'

const sample = [
  { gu: '11680', hour: 8, out: 52000 },
  { gu: '11350', hour: 8, out: 41000 },
  { gu: '11680', hour: 18, out: 61000 },
]

function grabPatch(r: EncodeResult): PointPatch {
  let patch: PointPatch | null = null
  const sink: PipelineSink = {
    setSourcePoints: (_id, p) => {
      patch = p
    },
    setSourceData: () => {},
  }
  r.apply(sink, 'x')
  if (patch === null) throw new Error('no patch pushed')
  return patch
}

describe('@xgis/pipeline · load', () => {
  it('is a strict re-composition — load({...}) equals the hand-composed chain', () => {
    const gaz = seoulSigunguGazetteer({ vintage: '2026' })

    // composable substrate (the ground truth)
    const composed = bubble(
      groupBy(
        where(join(fromRows(sample, { vintage: '2026' }), { code: 'gu', gaz, as: 'o' }), {
          hour: 8,
        }),
        {
          by: ['o.lon', 'o.lat', 'gu'],
          agg: { out: 'sum' },
        },
      ),
      { lon: 'o.lon', lat: 'o.lat', value: 'out' },
    )

    // declarative — reuses the SAME shipped verbs
    const declared = load({
      from: fromRows(sample, { vintage: '2026' }),
      join: { code: 'gu', gaz, as: 'o' },
      transform: [
        (t) => where(t, { hour: 8 }),
        (t) => groupBy(t, { by: ['o.lon', 'o.lat', 'gu'], agg: { out: 'sum' } }),
      ],
      show: (t) => bubble(t, { lon: 'o.lon', lat: 'o.lat', value: 'out' }),
    })

    const a = grabPatch(composed)
    const b = grabPatch(declared)
    expect(Array.from(b.lon)).toEqual(Array.from(a.lon))
    expect(Array.from(b.lat)).toEqual(Array.from(a.lat))
    expect(Array.from(b.properties!.radius as ArrayLike<number>)).toEqual(
      Array.from(a.properties!.radius as ArrayLike<number>),
    )
  })

  it('applies an ARRAY of joins left-to-right (the odFlow origin+dest double-join)', () => {
    const gaz = seoulSigunguGazetteer({ vintage: '2026' })
    const result = load({
      from: fromRows([{ o: '11680', d: '11350', n: 100 }], { vintage: '2026' }),
      join: [
        { code: 'o', gaz, as: 'origin' },
        { code: 'd', gaz, as: 'dest' },
      ],
      show: (t) => bubble(t, { lon: 'origin.lon', lat: 'origin.lat', value: 'n' }),
    })
    const patch = grabPatch(result)
    expect(patch.lon.length).toBe(1)
    // both handles were minted — origin near 강남 (127.0x), dest near 노원 (127.0–127.1)
    expect(patch.lon[0]).toBeGreaterThan(126)
    expect(patch.lon[0]).toBeLessThan(128)
  })

  it('runs with no join and no transform (from → show)', () => {
    const result = load({
      from: fromRows([{ lon: 127, lat: 37.5, v: 3 }], { vintage: '2026' }),
      show: (t) => bubble(t, { lon: 'lon', lat: 'lat', value: 'v' }),
    })
    expect(result.kind).toBe('points')
    expect(grabPatch(result).lon.length).toBe(1)
  })
})
