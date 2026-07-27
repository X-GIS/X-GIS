// ═══ bbox → coverage read window (ADR-0010 #1284-4, the S-102 viewport path) ═══
//
// `readBand(region)` could already skip chunks, but nothing above it could ASK for a
// window — the coverage entry points had no bbox, so a large S-102 cell still read
// whole. These gates pin the geographic→element mapping that closes that gap.
//
// chunked_shuffle is an S-102-shaped 3×4 cell (origin [0,0], spacing [1,1]) with (2,2)
// chunks → four chunks. A bbox over the SW quadrant resolves to chunk [0,0] alone.
//
// What each layer proves, kept honest: `region.test.ts` already gates that a region
// SKIPS chunks at the readBand level (its "outside = fill" holds with no masking in
// play). These gates own the two things stacked on top of it — the geographic→element
// mapping, and the not-fetched→NaN marking. The NaN assertions below would therefore
// still pass if the chunk filter regressed; they are a mapping+masking gate, not a
// substitute for that one. They ARE orientation-sensitive: the window is computed in
// south-row-first index space while the handle is north-up, so an inverted flip flips
// exactly which cells come back NaN (the dedicated test pins that pair).

import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readCoverageFromHdf5, readCoverageFromHdf5Url } from './coverage'
import { openHdf5Url } from './index'
import type { CoverageWindow } from './s102'

const FIX = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__')
const CELL = 'chunked_shuffle.h5'

/** A fixture by name, or any file by absolute path (the local-only real cell). */
function ab(nameOrPath: string): ArrayBuffer {
  const b = readFileSync(isAbsolute(nameOrPath) ? nameOrPath : join(FIX, nameOrPath))
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
}

/** The SW quadrant of the cell — exactly chunk [0,0] (south rows 0-1, cols 0-1). */
const SW_QUADRANT = [0, 0, 1, 1] as const
/** Every cell, over-covering both edges. */
const WHOLE_CELL = [0, 0, 3, 2] as const

function windowOf(meta: Record<string, unknown> | undefined): CoverageWindow | null {
  return (meta?.window ?? null) as CoverageWindow | null
}

/** A fetch that serves the fixture over HTTP Range and records every byte range asked
 *  for, so a test can prove a bbox read pulls STRICTLY fewer bytes than a whole read. */
function rangeHarness(name: string): { fetch: typeof globalThis.fetch; bytes: () => number } {
  const data = new Uint8Array(ab(name))
  let total = 0
  const fetch = (async (_u: string, init?: RequestInit) => {
    const header = (init?.headers as Record<string, string>).Range
    const m = /bytes=(\d+)-(\d+)/.exec(header)!
    const s = Number(m[1])
    const e = Math.min(Number(m[2]), data.byteLength - 1)
    total += e - s + 1
    return new Response(data.subarray(s, e + 1), {
      status: 206,
      headers: { 'Content-Range': `bytes ${s}-${e}/${data.byteLength}` },
    })
  }) as unknown as typeof globalThis.fetch
  return { fetch, bytes: () => total }
}

describe('bbox read window — geometry', () => {
  it('keeps the CELL geometry, not the window geometry', async () => {
    const full = await readCoverageFromHdf5(ab(CELL))
    const win = await readCoverageFromHdf5(ab(CELL), { bbox: SW_QUADRANT })
    // A window must never masquerade as a smaller cell — the renderer drapes the grid
    // by origin/spacing/size, so shrinking them here would silently move the data.
    expect(win.meta.origin).toEqual(full.meta.origin)
    expect(win.meta.spacing).toEqual(full.meta.spacing)
    expect(win.meta.size).toEqual(full.meta.size)
    expect(win.band('depth').values.length).toBe(full.band('depth').values.length)
  })

  it('reports the resident region in storage (south-first) indices + centre bounds', async () => {
    const win = await readCoverageFromHdf5(ab(CELL), { bbox: SW_QUADRANT })
    expect(windowOf(win.meta.sourceMeta)).toEqual({
      rowStart: 0,
      rowCount: 2,
      colStart: 0,
      colCount: 2,
      bounds: [0, 0, 1, 1],
    })
  })

  it('a whole-cell bbox equals the un-windowed read, cell for cell', async () => {
    const full = await readCoverageFromHdf5(ab(CELL))
    const win = await readCoverageFromHdf5(ab(CELL), { bbox: WHOLE_CELL })
    expect([...win.band('depth').values]).toEqual([...full.band('depth').values])
    expect([...win.band('uncertainty').values]).toEqual([...full.band('uncertainty').values])
  })

  it('a whole-cell read reports no window (null, not a full-span window)', async () => {
    const full = await readCoverageFromHdf5(ab(CELL))
    expect(windowOf(full.meta.sourceMeta)).toBeNull()
  })
})

describe('bbox read window — selectivity', () => {
  it('fetches only the intersecting chunk; every other chunk reads NaN', async () => {
    const win = await readCoverageFromHdf5(ab(CELL), { bbox: SW_QUADRANT })
    // In-window (chunk [0,0]) — real values, verbatim positive-down.
    expect(win.valueAt(0, 0)).toBe(20)
    expect(win.valueAt(1, 0)).toBe(21.5)
    expect(win.valueAt(0, 1)).toBe(26)
    expect(win.valueAt(1, 1)).toBe(27.5)
    // Outside — the chunk was never fetched, so the cells stay fill → NaN. A full read
    // returns 23 / 32 / 36.5 here, so these NaNs ARE the selectivity proof.
    expect(win.valueAt(2, 0)).toBeNaN() // chunk [0,2]
    expect(win.valueAt(0, 2)).toBeNaN() // chunk [2,0]
    expect(win.valueAt(3, 2)).toBeNaN() // chunk [2,2]
  })

  it('applies the window in SOUTH-first space (an inverted flip would mirror it)', async () => {
    const full = await readCoverageFromHdf5(ab(CELL))
    const win = await readCoverageFromHdf5(ab(CELL), { bbox: SW_QUADRANT })
    // The window is south rows 0-1 = the two SOUTHERN rows (lat 0 and 1), which live at
    // north-up rows 2 and 1. Had the region been applied to north-up indices instead,
    // the resident band would be the NORTHERN rows: valueAt(0,2) real and valueAt(0,0)
    // NaN — the exact inversion of this pair.
    expect(full.valueAt(0, 2)).toBe(32) // the northern cell IS real in a full read…
    expect(win.valueAt(0, 2)).toBeNaN() // …and absent from a southern window
    expect(win.valueAt(0, 0)).toBe(20) // while the southern cell is present
  })

  it('preserves in-cell nodata as NaN, distinct from an unfetched cell', async () => {
    // depth[southRow 1][col 2] is the 1e6 fill written INSIDE chunk [0,2]. Reading a
    // window that covers it proves a fetched-but-nodata cell and an unfetched cell both
    // read NaN — which is exactly why `sourceMeta.window` has to exist for a consumer
    // that needs to tell them apart.
    const win = await readCoverageFromHdf5(ab(CELL), { bbox: [2, 0, 3, 1] })
    expect(win.valueAt(2, 1)).toBeNaN() // in-window, but nodata in the source
    expect(win.valueAt(3, 1)).toBe(30.5) // in-window, real
    expect(win.valueAt(0, 0)).toBeNaN() // out of window
    expect(windowOf(win.meta.sourceMeta)).toMatchObject({ colStart: 2, colCount: 2 })
  })
})

describe('bbox read window — over HTTP Range', () => {
  it('carries the window over Range exactly as over a buffer', async () => {
    const buffered = await readCoverageFromHdf5(ab(CELL), { bbox: SW_QUADRANT })
    const ranged = await readCoverageFromHdf5Url('http://x/a.h5', {
      fetch: rangeHarness(CELL).fetch,
      blockSize: 64,
      bbox: SW_QUADRANT,
    })
    expect([...ranged.band('depth').values]).toEqual([...buffered.band('depth').values])
    expect(windowOf(ranged.meta.sourceMeta)).toEqual(windowOf(buffered.meta.sourceMeta))
  })
})

// ── Does a window actually cost less NETWORK? — real-cell only ────────────────
// A synthetic fixture CANNOT answer this, and the reason is worth recording so nobody
// re-attempts one: `walkChunkNode` ensures `min(NODE_WINDOW, byteLength − addr)` around
// the chunk b-tree (btree-v1.ts:17, NODE_WINDOW = 64 KB). Any cell smaller than roughly
// that faults its entire tail in while merely reading the chunk index, so a windowed and
// a whole read fetch identical byte totals — measured, not assumed: a purpose-built
// 64×64 / 16-chunk fixture pulled 50,193 B both ways. Committing a fixture big enough to
// clear the 64 KB window means committing ~½ MB of binary for one assertion.
//
// So the saving is gated on a real NOAA cell (local-only, no NOAA bytes committed) — a
// 1663×2090 / 16 m Chesapeake cell, 4.0 MB, chunked (66,104). Gated at readBand level
// rather than through `readCoverage`, because a real S-102 cell is PROJECTED (UTM) and
// the coverage path refuses it (see vlen-group-f.test.ts); the byte transport being
// measured sits below that guard either way.
//
// Measured, and the numbers are the point — the saving is REAL but block-size-bound:
//   blockSize  64 KB, 10% window → 1,507,329 / 3,932,161 B = 61.7% saved (16 vs 53 reqs)
//   blockSize 256 KB (default)   → 3,145,729 / 3,932,161 B = 20.0% saved (11 vs 14 reqs)
// The 256 KB default Cursor block is coarse against a 4 MB cell: each touched chunk drags
// a quarter-megabyte, diluting a selective read. A viewport-streaming caller should pass a
// smaller `blockSize`. The assertion below is pinned at the DEFAULT block so it measures
// what an unconfigured caller actually gets.
const noaaFile = join(FIX, '..', '__local__', 'noaa-s102.h5')
const GRID_PATH = 'BathymetryCoverage/BathymetryCoverage.01/Group_001/values'
describe.skipIf(!existsSync(noaaFile))('bbox window — real NOAA S-102 cell (local-only)', () => {
  async function readCorner(
    harness: ReturnType<typeof rangeHarness>,
    blockSize: number,
    region?: { start: number[]; count: number[] },
  ): Promise<void> {
    const f = await openHdf5Url('http://x/s102.h5', { fetch: harness.fetch, blockSize })
    await f.readBand(GRID_PATH, 'depth', region)
  }

  it('a viewport window streams materially fewer bytes at the default block size', async () => {
    const whole = rangeHarness(noaaFile)
    const windowed = rangeHarness(noaaFile)
    await readCorner(whole, 1 << 18)
    // ~10% of each axis at the grid's SW corner (storage rows are south-first).
    await readCorner(windowed, 1 << 18, { start: [0, 0], count: [209, 166] })
    expect(windowed.bytes()).toBeLessThan(whole.bytes())
    expect(windowed.bytes() / whole.bytes()).toBeLessThan(0.85) // measured 0.80
  })

  it('a smaller block size converts the selectivity into a much larger saving', async () => {
    // Pins the finding above rather than leaving it in a comment: the same window at a
    // 64 KB block saves far more, so the default block — not the chunk filter — is what
    // limits the win. If this ever stops holding, the transport changed.
    const whole = rangeHarness(noaaFile)
    const windowed = rangeHarness(noaaFile)
    await readCorner(whole, 1 << 16)
    await readCorner(windowed, 1 << 16, { start: [0, 0], count: [209, 166] })
    expect(windowed.bytes() / whole.bytes()).toBeLessThan(0.45) // measured 0.38
  })
})

describe('bbox read window — loud failures', () => {
  it('a bbox that misses the cell errors instead of returning an all-nodata grid', async () => {
    await expect(readCoverageFromHdf5(ab(CELL), { bbox: [10, 10, 12, 12] })).rejects.toThrow(
      /does not intersect the cell/,
    )
  })

  it('an inverted bbox errors and names the expected order', async () => {
    await expect(readCoverageFromHdf5(ab(CELL), { bbox: [3, 0, 0, 2] })).rejects.toThrow(
      /inverted — expected \[west, south, east, north\]/,
    )
  })

  it('a non-finite bbox errors', async () => {
    await expect(readCoverageFromHdf5(ab(CELL), { bbox: [0, 0, NaN, 2] })).rejects.toThrow(
      /four finite degrees/,
    )
  })
})
