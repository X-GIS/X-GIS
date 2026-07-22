// ═══ HDF5 subset reader — differential gate (#1158 GAP-1 INC-A gate 1) ═══
//
// The in-house reader's output is asserted EQUAL to h5py's (the offline oracle):
// committed .h5 fixtures + committed JSON goldens (data/tools/gen-h5-fixtures.py).
// Positive fixtures cover superblock v0 (symbol-table) + v2 (compact links), chunked
// + shuffle + gzip with PARTIAL edge chunks + PADDED compound offsets, a SPARSE
// (missing-chunk → fill) dataset, an asymmetric grid, a packed compound, and an
// S-111 surface-currents cell (the product-agnostic DCF2 sibling, #1272). A real
// Chesapeake CBOFS S-111 cell (public domain) is committed as a regression for the
// chunk-relative alignment fix (#1296). Negatives each fail LOUDLY naming the out-of-
// subset construct. The S-102 real-cell differential stays skipIf(!local).

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openHdf5, type Hdf5File } from './index'
import { readS102Coverage } from './s102'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIX = join(HERE, '__fixtures__')
const LOCAL = join(HERE, '__local__')
const GRID = 'BathymetryCoverage/BathymetryCoverage.01/Group_001/values'

function ab(path: string): ArrayBuffer {
  const b = readFileSync(path)
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
}
function golden(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIX, name + '.json'), 'utf8'))
}

const POSITIVES = [
  'sb_v0_symtab',
  'sb_v2_links',
  'chunked_shuffle',
  'asym_southflip',
  'packed_compound',
]

describe('HDF5 reader differential vs h5py (gate 1)', () => {
  it.each(POSITIVES)('%s: depth band == committed golden (storage order)', async (name) => {
    const g = golden(name)
    const f = await openHdf5(ab(join(FIX, name + '.h5')))
    const band = await f.readBand(GRID, 'depth')
    const expectedFlat = (g.depth_south_first as number[][]).flat()
    expect(band.dims).toEqual([g.nLat, g.nLon])
    expect(band.values.length).toBe(expectedFlat.length)
    for (let i = 0; i < expectedFlat.length; i++)
      expect(band.values[i]).toBeCloseTo(expectedFlat[i]!, 5)
  })

  it('sparse dataset fills a missing chunk from the fill value', async () => {
    const g = golden('sparse_chunk')
    const f = await openHdf5(ab(join(FIX, 'sparse_chunk.h5')))
    const band = await f.readBand(GRID, 'depth')
    const expected = (g.depth_south_first as number[][]).flat()
    for (let i = 0; i < expected.length; i++) expect(band.values[i]).toBeCloseTo(expected[i]!, 5)
    // the north-east 2×2 chunk was never written → all fill (777)
    expect(band.values).toContain(g.missing_chunk_fill)
  })

  it('S-102 semantic layer reads geometry + bands + vertical (case-tolerant)', async () => {
    const g = golden('sb_v0_symtab')
    const cov = await readS102Coverage(await openHdf5(ab(join(FIX, 'sb_v0_symtab.h5'))))
    expect(cov.product).toBe('s102')
    expect(cov.numPoints).toEqual([g.nLon, g.nLat])
    expect(cov.gridOrigin).toEqual(g.origin)
    expect(cov.gridSpacing).toEqual(g.spacing)
    expect(cov.vertical).toEqual({ datumCode: g.verticalDatum, sign: 'down' })
    expect(cov.bands.map((b) => b.name)).toEqual(g.bandNames)
    // fillValue provenance comes from the fixed-string Group_F band table
    expect(cov.bands[0]!.fillValue).toBe(g.fillValue)
  })

  it('registration is SW cell centre — corner vs centre discriminated (half-cell gate)', async () => {
    // origin=[5,50], spacing=[0.5,0.25]; the SW cell CENTRE is (5,50), not the
    // outer edge (5−0.25, 50−0.125). h5py wrote westBound=origin−spacing/2.
    const cov = await readS102Coverage(await openHdf5(ab(join(FIX, 'sb_v0_symtab.h5'))))
    expect(cov.gridOrigin[0]).toBeCloseTo(5.0, 9)
    expect(cov.gridOrigin[0]).not.toBeCloseTo(5.0 - 0.5 / 2, 6) // NOT the west edge
  })

  it('S-111 cell (NOAA surface currents): product-agnostic DCF2 read end-to-end', async () => {
    // The SAME semantic reader over an S-111-shaped file (#1272): container found
    // by dataCodingFormat (SurfaceCurrent, not BathymetryCoverage), the 2-member
    // {surfaceCurrentSpeed, surfaceCurrentDirection} compound decoded, Group_F
    // fill (-9999, a DIFFERENT sentinel than S-102's 1e6) + units read, product
    // detected from productSpecification.
    const g = golden('s111_dcf2')
    const cov = await readS102Coverage(await openHdf5(ab(join(FIX, 's111_dcf2.h5'))))
    expect(cov.product).toBe('s111')
    expect(cov.numPoints).toEqual([g.nLon, g.nLat])
    expect(cov.gridOrigin).toEqual(g.origin)
    expect(cov.gridSpacing).toEqual(g.spacing)
    expect(cov.bands.map((b) => b.name)).toEqual(g.bandNames)
    expect(cov.bands.map((b) => b.unit)).toEqual(g.bandUnits)
    expect(cov.bands.map((b) => b.fillValue)).toEqual([g.fillValue, g.fillValue])
    const speed = (g.speed_south_first as number[][]).flat()
    const dir = (g.direction_south_first as number[][]).flat()
    for (let i = 0; i < speed.length; i++) {
      expect(cov.bands[0]!.values[i]).toBeCloseTo(speed[i]!, 5)
      expect(cov.bands[1]!.values[i]).toBeCloseTo(dir[i]!, 5)
    }
    // The nodata cell carries the -9999 sentinel VERBATIM (the converter maps it
    // to NaN; the reader never rewrites values).
    expect(cov.bands[0]!.values[1 * (g.nLon as number) + 1]).toBe(-9999)
  })
})

describe('real NOAA S-111 CBOFS cell (committed public-domain regression)', () => {
  // A real Chesapeake Bay CBOFS forecast tile from noaa-s111-pds (a US government work,
  // public domain). Regresses the object-header chunk-relative alignment fix (#1296): this
  // cell has a symbol-table CONTINUATION block starting off an 8-byte boundary (0x7116),
  // which an ABSOLUTE align(8) skipped by 2 bytes — the walk then mis-read enum-datatype
  // text as a message type and threw. The synthetic fixtures never had a non-8-aligned
  // continuation block, so only a real cell caught it.
  it('reads a real S-111 cell end-to-end (product + geometry + currents)', async () => {
    const cov = await readS102Coverage(await openHdf5(ab(join(FIX, 'noaa_s111_cbofs.h5'))))
    expect(cov.product).toBe('s111')
    expect(cov.numPoints).toEqual([54, 54])
    expect(cov.bands.map((b) => b.name)).toEqual(['surfaceCurrentSpeed', 'surfaceCurrentDirection'])
    expect(cov.bands[0]!.unit).toBe('knots')
    const speed = cov.bands[0]!
    const valid = [...speed.values].filter((v) => v !== speed.fillValue && !Number.isNaN(v))
    expect(valid.length).toBe(2570)
    expect(Math.min(...valid)).toBeGreaterThan(0)
    expect(Math.max(...valid)).toBeLessThan(3) // knots — a tidal channel
  })
})

describe('HDF5 reader loud-fail negatives (out-of-subset → named error)', () => {
  const cases: [string, (f: Hdf5File) => unknown, RegExp][] = [
    // neg_v3_latest throws in openHdf5's init() (superblock parse) before `action` runs;
    // the others throw in the awaited action. Both surface as the rejection below.
    ['neg_v3_latest', (f) => f.root(), /superblock version 3/],
    ['neg_fletcher32', (f) => f.readBand('values'), /fletcher32/],
    ['neg_vlen', (f) => f.readBand('s'), /vlen/],
    ['neg_bigendian', (f) => f.readBand('values'), /big-endian/],
    ['neg_dense_attr', async (f) => (await f.get('g')).attrs(), /dense attribute storage/],
  ]
  it.each(cases)('%s errors naming the construct', async (name, action, re) => {
    await expect(
      async () => await action(await openHdf5(ab(join(FIX, name + '.h5')))),
    ).rejects.toThrow(re)
  })
})

// ── Real NOAA cell — local-only differential (no NOAA bytes committed) ─────────
const noaaFile = join(LOCAL, 'noaa-s102.h5')
const noaaGolden = join(LOCAL, 'noaa-golden.json')
const hasNoaa = existsSync(noaaFile) && existsSync(noaaGolden)
describe.skipIf(!hasNoaa)('real NOAA S-102 cell (local-only differential)', () => {
  it('depth grid + geometry match the h5py-dumped local golden', async () => {
    const g = JSON.parse(readFileSync(noaaGolden, 'utf8'))
    const f = await openHdf5(ab(noaaFile))
    const band = await f.readBand(GRID, 'depth')
    expect(band.dims).toEqual([g.nLat, g.nLon])
    // Differential vs the h5py golden over the chunked+gzip+partial-edge path: 5 sampled
    // cells + validCount + min/max. NOT a full-grid byte hash — for byte-exact coverage,
    // regenerate the local golden with hashlib.md5(d.astype('<f4').tobytes()) and compare.
    for (const [r, c, v] of g.samples as [number, number, number][])
      expect(band.values[r * g.nLon + c]).toBeCloseTo(v, 3)
    let min = Infinity,
      max = -Infinity,
      n = 0
    for (const v of band.values)
      if (v < 1e5) {
        n++
        if (v < min) min = v
        if (v > max) max = v
      }
    expect(n).toBe(g.validCount)
    expect(min).toBeCloseTo(g.validMin, 2)
    expect(max).toBeCloseTo(g.validMax, 2)
  })
})
