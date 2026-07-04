import { describe, it, expect, vi } from 'vitest'
import { seoulSigunguGazetteer } from '../gazetteer/kr'
import { encodeODB, type ODFlow } from '../odb/format'
import { krAdminLoader, odbLoader } from './index'

describe('@xgis/pipeline · loaders · krAdminLoader', () => {
  it('fetches a code-keyed CSV, joins to centroids, returns a bubble FeatureCollection', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const gaz = seoulSigunguGazetteer({ vintage: '2026' })
    // 99999 is not in the gazetteer → dropped + warned (the missing-code path).
    const csv = 'gu,out\n11680,52000\n11350,41000\n99999,1\n'
    const loader = krAdminLoader(gaz, { codeColumn: 'gu', valueColumn: 'out' })

    const result = await loader({
      id: 'flows',
      url: 'living-mobility.csv',
      options: {},
      fetch: async (_u: string) => new Response(csv),
    })

    expect(result.kind).toBe('fc')
    if (result.kind !== 'fc') throw new Error('expected an fc result')
    const fc = result.data
    expect(fc.type).toBe('FeatureCollection')
    expect(fc.features.length).toBe(2) // 99999 dropped
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('propagates a loud throw when NO admin code resolves (not a silent blank)', async () => {
    // Every code unknown → join drops all → NONE resolved → loud throw. Proves the
    // pipeline's fail-loud safety travels through the loader adapter unchanged.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const gaz = seoulSigunguGazetteer({ vintage: '2026' })
    const loader = krAdminLoader(gaz, { codeColumn: 'gu', valueColumn: 'out' })
    await expect(
      loader({
        id: 'x',
        url: 'x',
        options: {},
        fetch: async (_u: string) => new Response('gu,out\n99999,1\n88888,2\n'),
      }),
    ).rejects.toThrow(/resolved/)
    warn.mockRestore()
  })

  it('odbLoader decodes an .odb, sums inflow per node, emits bubbles', async () => {
    const gaz = seoulSigunguGazetteer({ vintage: '2026' })
    // 강남(11680) inflow = 5000+3000+2000 = 10000 across two origins + two hours.
    const flows: ODFlow[] = [
      { origin: '11110', dest: '11680', hour: 8, pop: 5000 },
      { origin: '11350', dest: '11680', hour: 8, pop: 3000 },
      { origin: '11110', dest: '11680', hour: 18, pop: 2000 },
    ]
    const buf = encodeODB(flows)
    const loader = odbLoader(gaz, { mode: 'inflow' })
    const result = await loader({
      id: 'flows',
      url: 'seoul.odb',
      options: {},
      fetch: async (_u: string) => new Response(buf),
    })
    expect(result.kind).toBe('fc')
    if (result.kind !== 'fc') throw new Error('expected fc')
    // one node (강남) received all inflow → one bubble feature
    expect(result.data.features.length).toBe(1)
  })

  it('odbLoader filters to a single hour when asked (daily-pulse frame)', async () => {
    const gaz = seoulSigunguGazetteer({ vintage: '2026' })
    const flows: ODFlow[] = [
      { origin: '11110', dest: '11680', hour: 8, pop: 5000 },
      { origin: '11110', dest: '11350', hour: 18, pop: 4000 }, // different hour + dest
    ]
    const loader = odbLoader(gaz, { mode: 'inflow', hour: 8 })
    const result = await loader({
      id: 'f',
      url: 'x.odb',
      options: {},
      fetch: async (_u: string) => new Response(encodeODB(flows)),
    })
    if (result.kind !== 'fc') throw new Error('expected fc')
    expect(result.data.features.length).toBe(1) // only the hour-8 flow survives
  })

  it('throws a clear HTTP error on a non-ok fetch (not a downstream parse error)', async () => {
    // safeFetch returns 4xx/5xx without throwing; the loader must guard status
    // BEFORE parsing so a 404 blames the fetch, not `join` (code-review MEDIUM).
    const gaz = seoulSigunguGazetteer({ vintage: '2026' })
    const loader = krAdminLoader(gaz, { codeColumn: 'gu', valueColumn: 'out' })
    await expect(
      loader({
        id: 'flows',
        url: 'missing.csv',
        options: {},
        fetch: async (_u: string) => new Response('Not Found', { status: 404 }),
      }),
    ).rejects.toThrow(/HTTP 404/)
  })
})
