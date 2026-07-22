// ═══ bbox-selective chunk fetch — readBand(region) (ADR-0010 #1284-4) ═══
//
// chunked_shuffle is a 3×4 grid with (2,2) chunks → four chunks (two partial edge). A
// `region` fetches ONLY the chunks intersecting it; a non-intersecting chunk is never
// read, so its cells stay fill. That "outside = fill" IS the selectivity proof — if the
// filter didn't skip the chunk, its real values would appear — and it holds independent
// of the byte-transport (buffer or range), so it's the robust gate. A whole-grid region
// must equal the un-regioned read.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openHdf5, openHdf5Range, RangeReader } from './index'

const FIX = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__')
const GRID = 'BathymetryCoverage/BathymetryCoverage.01/Group_001/values'
function ab(name: string): ArrayBuffer {
  const b = readFileSync(join(FIX, name))
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
}
function golden(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIX, name + '.json'), 'utf8'))
}

describe('readBand region — selective chunk fetch', () => {
  it('a whole-grid region equals the un-regioned read', async () => {
    const g = golden('chunked_shuffle')
    const full = (g.depth_south_first as number[][]).flat()
    const f = await openHdf5(ab('chunked_shuffle.h5'))
    const whole = await f.readBand(GRID, 'depth', { start: [0, 0], count: [3, 4] })
    expect([...whole.values]).toEqual(full)
  })

  it('a corner region reads only its chunk — other chunks stay fill (skipped, not fetched)', async () => {
    const g = golden('chunked_shuffle')
    const full = (g.depth_south_first as number[][]).flat()
    const f = await openHdf5(ab('chunked_shuffle.h5'))
    // top-left 2×2 = exactly the origin chunk [0,0]; the other three chunks
    // (origins [0,2], [2,0], [2,2]) do not intersect and must NOT be read.
    const region = await f.readBand(GRID, 'depth', { start: [0, 0], count: [2, 2] })
    // in-region cells match the full read
    for (let r = 0; r < 2; r++)
      for (let c = 0; c < 2; c++) expect(region.values[r * 4 + c]).toBe(full[r * 4 + c])
    // a cell in a non-intersecting chunk read as fill, NOT the real value — the chunk
    // was skipped (had it been fetched, region.values here would equal full).
    const farReal = full[2 * 4 + 3]!
    expect(region.values[2 * 4 + 3]).not.toBe(farReal)
    // every cell outside the fetched chunk is the SAME fill value (nothing else was read)
    const fill = region.values[2 * 4 + 3]
    expect(region.values[2 * 4 + 2]).toBe(fill) // chunk [2,2]
    expect(region.values[0 * 4 + 3]).toBe(fill) // chunk [0,2]
  })

  it('the region path also works over a RangeReader (only intersecting chunks fetched)', async () => {
    const g = golden('chunked_shuffle')
    const full = (g.depth_south_first as number[][]).flat()
    const data = new Uint8Array(ab('chunked_shuffle.h5'))
    const fetch = (async (_u: string, init?: RequestInit) => {
      const m = /bytes=(\d+)-(\d+)/.exec((init?.headers as Record<string, string>).Range)!
      const s = Number(m[1])
      const e = Math.min(Number(m[2]), data.byteLength - 1)
      return new Response(data.subarray(s, e + 1), {
        status: 206,
        headers: { 'Content-Range': `bytes ${s}-${e}/${data.byteLength}` },
      })
    }) as unknown as typeof globalThis.fetch
    const f = await openHdf5Range(await RangeReader.open('http://x/a.h5', { fetch }), {
      blockSize: 64,
    })
    const region = await f.readBand(GRID, 'depth', { start: [0, 0], count: [2, 2] })
    for (let r = 0; r < 2; r++)
      for (let c = 0; c < 2; c++) expect(region.values[r * 4 + c]).toBe(full[r * 4 + c])
  })
})
