// ═══ HDF5 subset reader — differential gate (#1158 GAP-1 INC-A gate 1) ═══
//
// The in-house reader's output is asserted EQUAL to h5py's (the offline oracle):
// committed .h5 fixtures + committed JSON goldens (pipeline/tools/gen-h5-fixtures.py).
// Positive fixtures cover superblock v0 (symbol-table) + v2 (compact links), chunked
// + shuffle + gzip with PARTIAL edge chunks + PADDED compound offsets, a SPARSE
// (missing-chunk → fill) dataset, an asymmetric grid, and a packed compound.
// Negatives each fail LOUDLY naming the out-of-subset construct. The real NOAA cell
// is a skipIf(!local) differential — no NOAA bytes committed (licence to-verify).

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openHdf5 } from './index'
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
    const f = openHdf5(ab(join(FIX, name + '.h5')))
    const band = await f.readBand(GRID, 'depth')
    const expectedFlat = (g.depth_south_first as number[][]).flat()
    expect(band.dims).toEqual([g.nLat, g.nLon])
    expect(band.values.length).toBe(expectedFlat.length)
    for (let i = 0; i < expectedFlat.length; i++)
      expect(band.values[i]).toBeCloseTo(expectedFlat[i]!, 5)
  })

  it('sparse dataset fills a missing chunk from the fill value', async () => {
    const g = golden('sparse_chunk')
    const f = openHdf5(ab(join(FIX, 'sparse_chunk.h5')))
    const band = await f.readBand(GRID, 'depth')
    const expected = (g.depth_south_first as number[][]).flat()
    for (let i = 0; i < expected.length; i++) expect(band.values[i]).toBeCloseTo(expected[i]!, 5)
    // the north-east 2×2 chunk was never written → all fill (777)
    expect(band.values).toContain(g.missing_chunk_fill)
  })

  it('S-102 semantic layer reads geometry + bands + vertical (case-tolerant)', async () => {
    const g = golden('sb_v0_symtab')
    const cov = await readS102Coverage(openHdf5(ab(join(FIX, 'sb_v0_symtab.h5'))))
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
    const cov = await readS102Coverage(openHdf5(ab(join(FIX, 'sb_v0_symtab.h5'))))
    expect(cov.gridOrigin[0]).toBeCloseTo(5.0, 9)
    expect(cov.gridOrigin[0]).not.toBeCloseTo(5.0 - 0.5 / 2, 6) // NOT the west edge
  })
})

describe('HDF5 reader loud-fail negatives (out-of-subset → named error)', () => {
  const cases: [string, (f: ReturnType<typeof openHdf5>) => unknown, RegExp][] = [
    ['neg_v3_latest', (f) => f.root(), /superblock version 3/],
    ['neg_fletcher32', (f) => f.readBand('values'), /fletcher32/],
    ['neg_vlen', (f) => f.readBand('s'), /vlen/],
    ['neg_bigendian', (f) => f.readBand('values'), /big-endian/],
    ['neg_dense_attr', (f) => f.get('g').attrs(), /dense attribute storage/],
  ]
  it.each(cases)('%s errors naming the construct', async (name, action, re) => {
    await expect(async () => await action(openHdf5(ab(join(FIX, name + '.h5'))))).rejects.toThrow(
      re,
    )
  })
})

// ── Real NOAA cell — local-only differential (no NOAA bytes committed) ─────────
const noaaFile = join(LOCAL, 'noaa-s102.h5')
const noaaGolden = join(LOCAL, 'noaa-golden.json')
const hasNoaa = existsSync(noaaFile) && existsSync(noaaGolden)
describe.skipIf(!hasNoaa)('real NOAA S-102 cell (local-only differential)', () => {
  it('depth grid + geometry match the h5py-dumped local golden', async () => {
    const g = JSON.parse(readFileSync(noaaGolden, 'utf8'))
    const f = openHdf5(ab(noaaFile))
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
