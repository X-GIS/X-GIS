import { describe, it, expect } from 'vitest'
import { encodeODB, decodeODB, ODB_MAGIC, ODB_HOUR_ALLDAY, type ODFlow } from './format'

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
    // eslint-disable-next-line no-console
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
})
