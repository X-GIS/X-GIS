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

  // ── #2361: filtering on a dimension the payload does not carry ───────────
  //
  // `ODBData.purpose` / `.segment` are `Uint8Array | null`, null whenever the
  // encoder saw a flow without the field. The filter read `&& data.purpose &&`,
  // so a null column short-circuited the whole test away and an explicit filter
  // returned every row — UNFILTERED data presented as filtered.

  it('#2361 a purpose filter over a payload with NO purpose column matches nothing', async () => {
    const gaz = seoulSigunguGazetteer({ vintage: '2026' })
    // No `purpose` on either flow → ODB_FLAG_PURPOSE unset → data.purpose null.
    const flows: ODFlow[] = [
      { origin: '11110', dest: '11680', hour: 8, pop: 5000 },
      { origin: '11350', dest: '11680', hour: 8, pop: 3000 },
    ]
    const loader = odbLoader(gaz, { mode: 'inflow', purpose: 3 })
    const result = await loader({
      id: 'f',
      url: 'x.odb',
      options: {},
      fetch: async (_u: string) => new Response(encodeODB(flows)),
    })
    if (result.kind !== 'fc') throw new Error('expected fc')
    // Pre-fix this was 1 — both flows summed into the 강남 bubble, identical to
    // asking for no filter at all.
    expect(result.data.features.length).toBe(0)
  })

  it('#2361 the same holds in ARC mode, and for segment', async () => {
    // Both branches carry the same four checks; a fix applied to one only would
    // pass the inflow test above and leave arc mode wrong.
    const gaz = seoulSigunguGazetteer({ vintage: '2026' })
    const flows: ODFlow[] = [
      { origin: '11110', dest: '11680', hour: 8, pop: 5000 },
      { origin: '11350', dest: '11680', hour: 8, pop: 3000 },
    ]
    const buf = encodeODB(flows)
    const req = {
      id: 'f',
      url: 'x.odb',
      options: {},
      fetch: async (_u: string) => new Response(buf),
    }

    const arc = await odbLoader(gaz, { mode: 'arc', purpose: 3 })(req)
    if (arc.kind !== 'fc') throw new Error('expected fc')
    expect(arc.data.features.length).toBe(0)

    const seg = await odbLoader(gaz, { mode: 'inflow', segment: 1 })(req)
    if (seg.kind !== 'fc') throw new Error('expected fc')
    expect(seg.data.features.length).toBe(0)
  })

  it('#2361 an UNFILTERED load of the same payload still returns its rows', async () => {
    // The control that separates "the filter now works" from "the loader now
    // returns nothing": same flows, no purpose/segment asked for, still 1
    // bubble. A fix that dropped rows unconditionally would pass both tests
    // above and break every existing caller.
    const gaz = seoulSigunguGazetteer({ vintage: '2026' })
    const flows: ODFlow[] = [
      { origin: '11110', dest: '11680', hour: 8, pop: 5000 },
      { origin: '11350', dest: '11680', hour: 8, pop: 3000 },
    ]
    const result = await odbLoader(gaz, { mode: 'inflow' })({
      id: 'f',
      url: 'x.odb',
      options: {},
      fetch: async (_u: string) => new Response(encodeODB(flows)),
    })
    if (result.kind !== 'fc') throw new Error('expected fc')
    expect(result.data.features.length).toBe(1)
  })

  it('#2361 when the column IS present the filter still selects by value', async () => {
    // The other half of the control: purpose present on every flow, so the
    // column decodes non-null and the value comparison must still govern.
    const gaz = seoulSigunguGazetteer({ vintage: '2026' })
    const flows: ODFlow[] = [
      { origin: '11110', dest: '11680', hour: 8, pop: 5000, purpose: 3 },
      { origin: '11350', dest: '11350', hour: 8, pop: 3000, purpose: 7 },
    ]
    const result = await odbLoader(gaz, { mode: 'inflow', purpose: 3 })({
      id: 'f',
      url: 'x.odb',
      options: {},
      fetch: async (_u: string) => new Response(encodeODB(flows)),
    })
    if (result.kind !== 'fc') throw new Error('expected fc')
    expect(result.data.features.length).toBe(1)
  })

  it('odbLoader arc mode emits a LineString FC, feature count = rows passing hour filter, endpoints in Seoul', async () => {
    const gaz = seoulSigunguGazetteer({ vintage: '2026' })
    const flows: ODFlow[] = [
      { origin: '11110', dest: '11680', hour: 8, pop: 5000 },
      { origin: '11350', dest: '11680', hour: 8, pop: 3000 },
      { origin: '11110', dest: '11680', hour: 18, pop: 2000 }, // filtered out by hour: 8
    ]
    const buf = encodeODB(flows)
    const loader = odbLoader(gaz, { mode: 'arc', hour: 8 })
    const result = await loader({
      id: 'arcs',
      url: 'seoul.odb',
      options: {},
      fetch: async (_u: string) => new Response(buf),
    })

    expect(result.kind).toBe('fc')
    if (result.kind !== 'fc') throw new Error('expected fc')
    const fc = result.data

    // 2 rows survive the hour:8 filter → 2 LineString features
    expect(fc.features.length).toBe(2)

    for (const feat of fc.features as {
      geometry: { type: string; coordinates: number[][] }
      properties: { weight: number }
    }[]) {
      expect(feat.geometry.type).toBe('LineString')
      expect(feat.geometry.coordinates).toHaveLength(2)
      // Both endpoints must resolve to Seoul centroids (lon 126–128)
      expect(feat.geometry.coordinates[0]![0]).toBeGreaterThan(126)
      expect(feat.geometry.coordinates[0]![0]).toBeLessThan(128)
      expect(feat.geometry.coordinates[1]![0]).toBeGreaterThan(126)
      expect(feat.geometry.coordinates[1]![0]).toBeLessThan(128)
      // weight property carried through
      expect(feat.properties.weight).toBeGreaterThan(0)
    }
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
