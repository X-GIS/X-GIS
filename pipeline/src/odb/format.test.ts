import { describe, it, expect } from 'vitest'
import {
  encodeODB,
  decodeODB,
  ODB_MAGIC,
  ODB_HOUR_ALLDAY,
  ODB_FLAG_PURPOSE,
  ODB_FLAG_SEGMENT,
  type ODFlow,
} from './format'

// A synthetic 시군구-scale OD set: 25 codes × 25 codes × 24 hours = 15000 flows,
// the shape a 수도권 생활이동 hero aggregate takes after rollup to 시군구.
function synthFlows(withAvgTime = false): ODFlow[] {
  const codes = Array.from({ length: 25 }, (_, i) => String(11110 + i * 10)) // 11110..11350
  const flows: ODFlow[] = []
  for (const o of codes)
    for (const d of codes)
      for (let h = 0; h < 24; h++) {
        const f: ODFlow = { origin: o, dest: d, hour: h, pop: (Number(o) + Number(d) + h) % 90000 }
        if (withAvgTime) f.avgTime = 10 + (h % 12)
        flows.push(f)
      }
  return flows
}

describe('@xgis/pipeline · odb format', () => {
  it('round-trips flows byte-for-value (encode → decode)', () => {
    const flows = synthFlows()
    const buf = encodeODB(flows)
    const data = decodeODB(buf)
    expect(data.rowCount).toBe(flows.length)
    expect(new DataView(buf).getUint32(0, true)).toBe(ODB_MAGIC)
    // spot-check first, middle, last
    for (const i of [0, 7500, flows.length - 1]) {
      expect(data.flow(i)).toEqual(flows[i])
    }
    // dict resolved the 25 distinct codes
    expect(data.dict.length).toBe(25)
  })

  it('carries avgTime only when every row has it', () => {
    const withT = decodeODB(encodeODB(synthFlows(true)))
    expect(withT.avgTime).not.toBeNull()
    expect(withT.flow(0).avgTime).toBeDefined()
    const withoutT = decodeODB(encodeODB(synthFlows(false)))
    expect(withoutT.avgTime).toBeNull()
    expect(withoutT.flow(0).avgTime).toBeUndefined()
  })

  it('compresses vastly vs the equivalent CSV (the whole point)', () => {
    const flows = synthFlows()
    const odb = encodeODB(flows).byteLength
    // The equivalent CSV a naive export would ship: "origin,dest,hour,pop\n" rows.
    const csv =
      'origin,dest,hour,pop\n' +
      flows.map((f) => `${f.origin},${f.dest},${f.hour},${f.pop}`).join('\n')
    const csvBytes = new TextEncoder().encode(csv).byteLength

    console.log(
      `[.odb] ${flows.length} flows: odb=${(odb / 1024).toFixed(1)}KB csv=${(csvBytes / 1024).toFixed(1)}KB ` +
        `ratio=${(csvBytes / odb).toFixed(1)}x`,
    )
    // odb (9 bytes/row + tiny dict) must be well under half the CSV text.
    expect(odb).toBeLessThan(csvBytes * 0.6)
    // and small enough for a hero fetch: 15k 시군구 flows < 200KB.
    expect(odb).toBeLessThan(200 * 1024)
  })

  it('supports an all-day (unbucketed) hour sentinel', () => {
    const buf = encodeODB([{ origin: '11110', dest: '11680', hour: ODB_HOUR_ALLDAY, pop: 5000 }])
    expect(decodeODB(buf).flow(0).hour).toBe(ODB_HOUR_ALLDAY)
  })

  it('throws loud on a bad magic (never a silent mis-parse)', () => {
    const bad = new ArrayBuffer(16)
    new DataView(bad).setUint32(0, 0xdeadbeef, true)
    expect(() => decodeODB(bad)).toThrow(/bad magic/)
  })

  it('throws on a truncated buffer', () => {
    const full = encodeODB(synthFlows())
    const cut = full.slice(0, 40) // header + partial dict
    expect(() => decodeODB(cut)).toThrow(/truncated|too small/)
  })

  it('round-trips purpose + segment columns (encode → decode)', () => {
    // 3 flows covering the full segment range and two distinct purpose values.
    const flows: ODFlow[] = [
      { origin: '11110', dest: '11120', hour: 8, pop: 100, purpose: 1, segment: 0 },
      { origin: '11120', dest: '11130', hour: 9, pop: 200, purpose: 3, segment: 1 },
      { origin: '11130', dest: '11110', hour: 18, pop: 50, purpose: 7, segment: 2 },
    ]
    const buf = encodeODB(flows)
    const flags = new DataView(buf).getUint16(6, true)
    expect(flags & ODB_FLAG_PURPOSE).toBeTruthy()
    expect(flags & ODB_FLAG_SEGMENT).toBeTruthy()
    const data = decodeODB(buf)
    expect(data.purpose).not.toBeNull()
    expect(data.segment).not.toBeNull()
    expect(Array.from(data.purpose!)).toEqual([1, 3, 7])
    expect(Array.from(data.segment!)).toEqual([0, 1, 2])
    for (let i = 0; i < flows.length; i++) {
      expect(data.flow(i).purpose).toBe(flows[i]!.purpose)
      expect(data.flow(i).segment).toBe(flows[i]!.segment)
    }
  })

  it('back-compat: old-shape flows (no purpose/segment) decode to null arrays', () => {
    // Flows without purpose/segment — mirrors a v1 file written before this extension.
    const flows: ODFlow[] = [
      { origin: '11110', dest: '11120', hour: 8, pop: 100 },
      { origin: '11120', dest: '11130', hour: 9, pop: 200 },
    ]
    const buf = encodeODB(flows)
    const flags = new DataView(buf).getUint16(6, true)
    expect(flags & ODB_FLAG_PURPOSE).toBe(0)
    expect(flags & ODB_FLAG_SEGMENT).toBe(0)
    const data = decodeODB(buf)
    expect(data.purpose).toBeNull()
    expect(data.segment).toBeNull()
    expect(data.flow(0).purpose).toBeUndefined()
    expect(data.flow(0).segment).toBeUndefined()
  })
})
