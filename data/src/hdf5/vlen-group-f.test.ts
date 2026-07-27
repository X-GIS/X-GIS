// ═══ Group_F as VLEN strings + the projected-CRS refusal (real-NOAA-S-102 shape) ═══
//
// Two things stood between the reader and a real NOAA S-102 cell, both found by
// downloading one rather than by reading the spec:
//
//   1. Group_F is written as VLEN strings (bytes in a global heap), not the fixed
//      strings the synthetic corpus and real S-111 use. The reader rejected the whole
//      table, so NO real S-102 cell could be read at all — and the table is where
//      `fillValue` lives, so it cannot simply be skipped: without it the 1e6 nodata
//      sentinel decodes as a real 1,000,000 m depth.
//   2. The grid is in a PROJECTED CRS (EPSG:32618, UTM 18N — origin ~[420768, 4183857],
//      spacing 16 m). `coverageFromGrids` stamps every handle EPSG:4326 and the renderer
//      drapes by inverse-Mercator rows, so such a cell would be placed as if metres were
//      degrees. That is refused loudly rather than mis-rendered.
//
// The vlen fixture is committed so CI gates (1); the real cell stays local-only.

import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openHdf5 } from './index'
import { readCoverageFromHdf5 } from './coverage'
import { readS102Coverage } from './s102'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIX = join(HERE, '__fixtures__')

function ab(path: string): ArrayBuffer {
  const b = readFileSync(path)
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
}
const fixture = (name: string): ArrayBuffer => ab(join(FIX, name))

describe('Group_F written as vlen strings', () => {
  it('decodes the band table, so fillValue still maps nodata to NaN', async () => {
    // The load-bearing assertion: `1e6` is the S-100 fill, and it only becomes NaN
    // because the vlen `fillValue` string was decoded out of the global heap. A reader
    // that skipped the table would surface a 1,000,000 m sounding here.
    const h = await readCoverageFromHdf5(fixture('vlen_group_f.h5'))
    expect(h.valueAt(3, 2)).toBeNaN() // the seeded nodata cell
    expect(h.valueAt(0, 0)).toBe(10) // SW cell, real value
    expect(h.band('depth').header.nodata).toBe(1e6)
    expect(h.band('depth').header.unit).toBe('metres')
  })

  it('produces the same table a fixed-string cell would', async () => {
    // Encoding is a storage detail; the decoded rows must not differ by it.
    const vlen = await openHdf5(fixture('vlen_group_f.h5'))
    const fixed = await openHdf5(fixture('sb_v0_symtab.h5'))
    const rows = await vlen.readStringTable('Group_F/BathymetryCoverage')
    const ref = await fixed.readStringTable('Group_F/BathymetryCoverage')
    expect(rows.map((r) => r['code'])).toEqual(ref.map((r) => r['code']))
    expect(rows.map((r) => r['uom.name'])).toEqual(ref.map((r) => r['uom.name']))
    expect(rows[0]).toMatchObject({ code: 'depth', 'uom.name': 'metres', fillValue: '1000000' })
  })

  it('still rejects a vlen GRID BAND — only the string table accepts vlen', async () => {
    // The subset boundary did not move: a vlen band is unreadable numeric data and must
    // stay a loud failure (neg_vlen), even though the metadata table now decodes.
    const f = await openHdf5(fixture('neg_vlen.h5'))
    await expect(f.readBand('s')).rejects.toThrow(/vlen/)
  })
})

describe('projected-CRS cells are refused, not misplaced', () => {
  it('a geographic cell is NOT refused (the guard is not a blanket rejection)', async () => {
    const f = await openHdf5(fixture('chunked_shuffle.h5'))
    expect((await f.root()).attr('horizontalCRS')).toBe(4326)
    await expect(readS102Coverage(f)).resolves.toBeTruthy()
  })

  it('an ABSENT horizontalCRS stays permitted (real NOAA S-111 omits it)', async () => {
    // Regression guard for the shipped currents demo: tightening the CRS check must not
    // reject a cell that simply does not declare one.
    const f = await openHdf5(fixture('noaa_s111_cbofs.h5'))
    expect((await f.root()).attr('horizontalCRS')).toBeUndefined()
    await expect(readS102Coverage(f)).resolves.toBeTruthy()
  })
})

// ── The real NOAA S-102 cell — local-only (no NOAA bytes committed) ────────────
const noaaFile = join(HERE, '__local__', 'noaa-s102.h5')
describe.skipIf(!existsSync(noaaFile))('real NOAA S-102 cell (local-only)', () => {
  it('reads its vlen Group_F and is then refused for being projected', async () => {
    const f = await openHdf5(ab(noaaFile))
    // The table decodes — this is the fix, proven on the bytes that motivated it.
    const rows = await f.readStringTable('Group_F/BathymetryCoverage')
    expect(rows.map((r) => r['code'])).toContain('depth')
    expect(rows[0]!['fillValue']).toBeTruthy()
    // …and the cell is still refused, because its grid is UTM, not degrees.
    expect((await f.root()).attr('horizontalCRS')).toBe(32618)
    await expect(readS102Coverage(f)).rejects.toThrow(/PROJECTED grid/)
  })
})
