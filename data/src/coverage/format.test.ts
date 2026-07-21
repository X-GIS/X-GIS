// ═══ .xgcov codec gates (#1158 GAP-1 INC-A gates 2 + 4 + fail-first south-flip) ═══
//
// Gate 2 — round-trip byte-exact (bound to DECODED raw grids + header, never the
// compressed bytes: deflate output is not cross-runtime deterministic, A2) +
// u16 quantization error ≤ scale/2. Gate 4 (sign) — valueAt positive-down verbatim
// + meta.vertical { datumCode, sign:'down' }. Gate 1 fail-first south-flip lives
// here too: the asymmetric grid asserts the north-up decode AND proves fail-before
// by pointing the same assertion at the unflipped grid.

import { describe, it, expect } from 'vitest'
import {
  encodeCoverage,
  decodeCoverage,
  coverageFromGrids,
  southFirstToNorthUp,
  type CoverageInput,
} from './format'

const FILL = 1e6
// asymmetric 2×3 grid, NORTH-UP (row 0 = north): distinct per cell so a transpose
// or a flip bug is caught; SE cell (south row) is nodata.
const N_LON = 3
const N_LAT = 2
const DEPTH_NORTH_UP = new Float32Array([20, 21, 22, /* south */ 10, 11, FILL])

function baseInput(kind: 'f32' | 'u16'): CoverageInput {
  return {
    product: 's102',
    origin: [5, 50], // SW cell CENTRE
    spacing: [2, 1],
    size: [N_LON, N_LAT],
    bands: [{ name: 'depth', unit: 'metres', kind, nodata: FILL, values: DEPTH_NORTH_UP.slice() }],
    vertical: { datumCode: 23, sign: 'down' },
  }
}

/** Inflate the FIRST band block out of an encoded .xgcov buffer → the raw (uncompressed)
 *  grid bytes. inflate(deflate(x)) === x deterministically, so this exposes the exact
 *  bytes the encoder stored (independent of deflate's non-deterministic output). */
async function firstBlockRaw(buf: ArrayBuffer): Promise<Uint8Array> {
  const view = new DataView(buf)
  const headerLen = view.getUint32(6, true)
  const o = 10 + headerLen
  const clen = view.getUint32(o, true)
  const comp = new Uint8Array(buf.slice(o + 4, o + 4 + clen))
  const ds = new DecompressionStream('deflate')
  const w = ds.writable.getWriter()
  void w.write(comp).catch(() => {})
  void w.close().catch(() => {})
  const chunks: Uint8Array[] = []
  const reader = ds.readable.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) chunks.push(value)
  }
  let total = 0
  for (const c of chunks) total += c.length
  const out = new Uint8Array(total)
  let p = 0
  for (const c of chunks) {
    out.set(c, p)
    p += c.length
  }
  return out
}

describe('gate 2 — round-trip byte-exact (decoded grids + header)', () => {
  it('f32 band: decoded values + header equal the input (NaN at nodata)', async () => {
    const handle = await decodeCoverage(await encodeCoverage(baseInput('f32')))
    const v = handle.band(0).values
    expect(Array.from(v.slice(0, 5))).toEqual([20, 21, 22, 10, 11])
    expect(Number.isNaN(v[5]!)).toBe(true)
    expect(handle.header.size).toEqual([N_LON, N_LAT])
    expect(handle.header.origin).toEqual([5, 50])
    expect(handle.header.registration).toBe('point')
    // header.nodata carries the ORIGINAL source fill (provenance), runtime uses NaN
    expect(handle.header.bands[0]!.nodata).toBe(FILL)
    expect(handle.header.bands[0]!.min).toBe(10)
    expect(handle.header.bands[0]!.max).toBe(22)
  })

  it('f32 nodata is the canonical quiet NaN 0x7FC00000 (byte-stable round-trip)', async () => {
    const buf = await encodeCoverage(baseInput('f32'))
    // Inspect the STORED bits (not just the decoded grid, which canonicalizes any NaN to
    // 0x7FC00000 on read and would pass for ANY encoded NaN). The nodata cell (index 5)
    // must be exactly the canonical quiet NaN, and valid cells their verbatim f32 bits —
    // this is the byte-stability property the header promises (deflate output is not
    // cross-runtime stable, but the raw f32 block IS).
    const raw = await firstBlockRaw(buf)
    expect(raw.length).toBe(N_LON * N_LAT * 4)
    const bits = new Uint32Array(raw.buffer, raw.byteOffset, N_LON * N_LAT)
    expect(bits[5]).toBe(0x7fc00000) // SE cell = nodata → canonical quiet NaN
    const f = new Float32Array(raw.buffer, raw.byteOffset, N_LON * N_LAT)
    expect(Array.from(f.slice(0, 5))).toEqual([20, 21, 22, 10, 11]) // valid cells verbatim
  })

  it('u16 quantization error ≤ scale/2 over EVERY valid cell; 0xFFFF → NaN', async () => {
    const handle = await decodeCoverage(await encodeCoverage(baseInput('u16')))
    const bh = handle.header.bands[0]!
    const scale = bh.scale!
    const v = handle.band(0).values
    for (let i = 0; i < DEPTH_NORTH_UP.length; i++) {
      if (DEPTH_NORTH_UP[i] === FILL) {
        expect(Number.isNaN(v[i]!)).toBe(true)
        continue
      }
      expect(Math.abs(DEPTH_NORTH_UP[i]! - v[i]!)).toBeLessThanOrEqual(scale / 2 + 1e-9)
    }
    // min/max computed over VALID cells only — the 1e6 fill never inflates the range
    expect(bh.min).toBe(10)
    expect(bh.max).toBe(22)
  })

  it('u16 exposes exact codes for GPU s = code/65534; nodata code = 0xFFFF', async () => {
    const handle = await decodeCoverage(await encodeCoverage(baseInput('u16')))
    const codes = handle.band(0).codes!
    // values [20,21,22,10,11,FILL]: 22 is max → top code, 10 is min → 0, FILL → nodata
    expect(codes[2]).toBe(65534) // max value (22) → top code
    expect(codes[3]).toBe(0) // min value (10) → 0
    expect(codes[5]).toBe(0xffff) // nodata
    expect(codes[0]).toBe(Math.round(((20 - 10) / (22 - 10)) * 65534)) // exact s = code/65534
  })

  it('degenerate max == min band: scale falls back to 1, values reconstruct exactly', async () => {
    const flat = new Float32Array([7, 7, 7, 7, 7, 7])
    const handle = await decodeCoverage(
      await encodeCoverage({ ...baseInput('u16'), bands: [{ name: 'd', unit: '', kind: 'u16', nodata: FILL, values: flat }] }),
    )
    expect(handle.header.bands[0]!.scale).toBe(1)
    for (const v of handle.band(0).values) expect(v).toBe(7)
  })
})

describe('gate 4 — sign gate: valueAt positive-down verbatim + meta.vertical', () => {
  it('valueAt: nearest-cell, OOB null, nodata NaN, positive-down verbatim', async () => {
    const handle = await decodeCoverage(await encodeCoverage(baseInput('f32')))
    // origin [5,50], spacing [2,1]. south row (rowS 0) at lat 50; north row at 51.
    expect(handle.valueAt(5, 50)).toBe(10) // SW
    expect(handle.valueAt(5, 51)).toBe(20) // NW
    expect(handle.valueAt(7, 51)).toBe(21) // N mid
    expect(Number.isNaN(handle.valueAt(9, 50)!)).toBe(true) // SE nodata
    expect(handle.valueAt(-100, 0)).toBeNull() // OOB
    expect(handle.valueAt(5, 90)).toBeNull() // OOB north
  })

  it('nearest-cell rounding: ±0.49 cell offsets snap to the cell centre', async () => {
    const handle = await decodeCoverage(await encodeCoverage(baseInput('f32')))
    // spacing lon=2: ±0.49·2 = ±0.98 from centre 5 stays cell 0
    expect(handle.valueAt(5.9, 50)).toBe(10)
    expect(handle.valueAt(4.1, 50)).toBe(10)
    // +1.1 in lon (>half of 2) rounds to col 1
    expect(handle.valueAt(6.2, 50)).toBe(11)
  })

  it('positive-down verbatim: a depth of 10 m stays +10 (no sign flip); meta carries datum', async () => {
    const handle = await decodeCoverage(await encodeCoverage(baseInput('f32')))
    expect(handle.valueAt(5, 50)).toBe(10) // NOT −10
    expect(handle.meta.vertical).toEqual({ datumCode: 23, sign: 'down' })
  })

  it('exact index math on the asymmetric grid: idx = (nLat−1−rowS)·nLon + col', async () => {
    const handle = await decodeCoverage(await encodeCoverage(baseInput('f32')))
    // every in-bounds (col,rowS) resolves to the north-up storage cell
    for (let rowS = 0; rowS < N_LAT; rowS++)
      for (let col = 0; col < N_LON; col++) {
        const lon = 5 + col * 2
        const lat = 50 + rowS * 1
        const idx = (N_LAT - 1 - rowS) * N_LON + col
        const expected = handle.band(0).values[idx]!
        const got = handle.valueAt(lon, lat)
        if (Number.isNaN(expected)) expect(Number.isNaN(got!)).toBe(true)
        else expect(got).toBe(expected)
      }
  })
})

describe('gate 1 fail-first — south-row flip normalized exactly once', () => {
  const SOUTH_FIRST = new Float32Array([10, 11, FILL, /* north */ 20, 21, 22]) // row 0 = SOUTH
  const EXPECTED_NORTH_UP = [20, 21, 22, 10, 11, FILL] // row 0 = NORTH

  it('southFirstToNorthUp flips the asymmetric grid (row 0 becomes north)', () => {
    const nu = southFirstToNorthUp(SOUTH_FIRST, N_LON, N_LAT)
    expect(Array.from(nu)).toEqual(EXPECTED_NORTH_UP)
  })

  it('FAIL-BEFORE: the SAME assertion on the UNFLIPPED grid fails (proves the flip matters)', () => {
    // Pointing the north-up assertion at the raw south-first decode must NOT match —
    // this is the fail-first witness that the flip is load-bearing, not a no-op.
    expect(Array.from(SOUTH_FIRST)).not.toEqual(EXPECTED_NORTH_UP)
  })

  it('valueAt over a converted south-first grid returns the correct geographic cell', async () => {
    const northUp = southFirstToNorthUp(SOUTH_FIRST, N_LON, N_LAT)
    const handle = await decodeCoverage(
      await encodeCoverage({ ...baseInput('f32'), bands: [{ name: 'depth', unit: 'm', kind: 'f32', nodata: FILL, values: northUp }] }),
    )
    expect(handle.valueAt(5, 50)).toBe(10) // south stays south
    expect(handle.valueAt(5, 51)).toBe(20) // north stays north
  })
})

describe('codec negatives — loud on corruption', () => {
  it('wrong magic errors', async () => {
    const buf = await encodeCoverage(baseInput('f32'))
    new Uint8Array(buf)[0] = 0x00
    await expect(decodeCoverage(buf)).rejects.toThrow(/bad magic/)
  })
  it('wrong version errors', async () => {
    const buf = await encodeCoverage(baseInput('f32'))
    new DataView(buf).setUint16(4, 99, true)
    await expect(decodeCoverage(buf)).rejects.toThrow(/unsupported version/)
  })
  it('truncated buffer errors', async () => {
    const buf = await encodeCoverage(baseInput('f32'))
    await expect(decodeCoverage(buf.slice(0, 8))).rejects.toThrow(/too small|truncated/)
  })
  it('block-length overrun errors', async () => {
    const buf = await encodeCoverage(baseInput('f32'))
    // corrupt the first block's compressedLen to overrun the buffer
    const view = new DataView(buf)
    const headerLen = view.getUint32(6, true)
    view.setUint32(10 + headerLen, 0x7fffffff, true)
    await expect(decodeCoverage(buf)).rejects.toThrow(/truncated block/)
  })
})

// ── ADR-0010: grids → CoverageHandle, no wire format ──────────────────────────
describe('coverageFromGrids — the reader→renderer seam (ADR-0010)', () => {
  it('is EQUIVALENT to the encode→decode round-trip at kind:f32 (no .xgcov needed)', async () => {
    // The whole point of the seam: a reader that yields grids can build the exact
    // same CoverageHandle the .xgcov path produces, with no transcode. If this
    // holds, removing .xgcov loses nothing on the render/readout side.
    const direct = coverageFromGrids(baseInput('f32'))
    const viaXgcov = await decodeCoverage(await encodeCoverage(baseInput('f32')))

    expect(direct.header.size).toEqual(viaXgcov.header.size)
    expect(direct.header.origin).toEqual(viaXgcov.header.origin)
    expect(direct.header.spacing).toEqual(viaXgcov.header.spacing)
    expect(direct.header.product).toBe(viaXgcov.header.product)
    expect(direct.header.vertical).toEqual(viaXgcov.header.vertical)

    const db = direct.band('depth')
    const xb = viaXgcov.band('depth')
    expect(db.header.min).toBe(xb.header.min)
    expect(db.header.max).toBe(xb.header.max)
    expect(db.values.length).toBe(xb.values.length)
    for (let i = 0; i < db.values.length; i++) {
      if (Number.isNaN(xb.values[i]!)) expect(Number.isNaN(db.values[i]!)).toBe(true)
      else expect(db.values[i]).toBeCloseTo(xb.values[i]!, 5)
    }
  })

  it('valueAt matches the round-trip — verbatim value, NaN at nodata, null out of bounds', () => {
    const h = coverageFromGrids(baseInput('f32'))
    // NW cell centre (origin=[5,50], spacing=[2,1], 3×2): (5,51) = north row, col 0 = 20
    expect(h.valueAt(5, 51, 'depth')).toBe(20)
    // SE cell is the nodata fill → NaN
    expect(Number.isNaN(h.valueAt(9, 50, 'depth')!)).toBe(true)
    // outside the grid bounds → null
    expect(h.valueAt(200, 200, 'depth')).toBeNull()
  })

  it('maps a source fill AND a pre-existing NaN to NaN; min/max skip both', () => {
    const input = baseInput('f32')
    input.bands[0]!.values = new Float32Array([20, NaN, 22, 10, FILL, 12])
    const h = coverageFromGrids(input)
    const b = h.band('depth')
    expect(Number.isNaN(b.values[1]!)).toBe(true) // pre-existing NaN
    expect(Number.isNaN(b.values[4]!)).toBe(true) // source fill
    expect(b.header.min).toBe(10)
    expect(b.header.max).toBe(22)
  })

  it('a wrong cell count fails loudly (never a silent short grid)', () => {
    const input = baseInput('f32')
    input.bands[0]!.values = new Float32Array([1, 2, 3]) // 3 ≠ 6
    expect(() => coverageFromGrids(input)).toThrow(/band "depth" has 3 cells, expected 6/)
  })
})
