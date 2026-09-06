// #2560 — the (z, y) row geometry `emitTileAt` used to compute inline.
//
// These values are written straight into a shader uniform (`writeRasterTileUniform`
// takes south / north / mercSouth / mercDiff), so "close enough" is not the bar:
// a memo that returns a DIFFERENT number moves the raster quad. The differential
// row below therefore asserts exact f64 equality against the retired expression,
// transcribed verbatim from the call site it replaced:
//
//     const north = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / rn))) * 180) / Math.PI
//     const south = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / rn))) * 180) / Math.PI
//     const mercSouth = Math.log(Math.tan(Math.PI / 4 + (clampMerc(south) * DEG2RAD) / 2))
//     const mercNorth = Math.log(Math.tan(Math.PI / 4 + (clampMerc(north) * DEG2RAD) / 2))
//     const mercDiff  = mercNorth - mercSouth
//
// The memo's KEY is the other half of the claim: it omits x and the world copy.
// That is licensed by the expression above containing neither — pinned by a
// source gate, because the licence is the thing a future edit would break
// silently (adding an x term would make every column share one row's bounds).

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { computeRowGeom, ROW_GEOM_MAX_PER_Z, RowGeomCache } from './raster-row-geom'

const HERE = dirname(fileURLToPath(import.meta.url))

/** The retired inline expression, kept as the reference implementation. */
function inlineRowGeom(
  z: number,
  y: number,
): {
  north: number
  south: number
  mercSouth: number
  mercDiff: number
} {
  const rn = Math.pow(2, z)
  const north = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / rn))) * 180) / Math.PI
  const south = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / rn))) * 180) / Math.PI
  const DEG2RAD = Math.PI / 180
  const MERC_LIMIT = 85.051129
  const clampMerc = (v: number): number => Math.max(-MERC_LIMIT, Math.min(MERC_LIMIT, v))
  const mercSouth = Math.log(Math.tan(Math.PI / 4 + (clampMerc(south) * DEG2RAD) / 2))
  const mercNorth = Math.log(Math.tan(Math.PI / 4 + (clampMerc(north) * DEG2RAD) / 2))
  return { north, south, mercSouth, mercDiff: mercNorth - mercSouth }
}

describe('computeRowGeom — byte-identical to the expression it replaced (#2560)', () => {
  it('agrees exactly across the whole zoom range, poles included', () => {
    // Exact equality, not a tolerance: the memo is a caching change, so any
    // difference at all is a behaviour change reaching the shader. Row 0 and the
    // last row of each level are the ones that hit the Mercator clamp.
    for (let z = 0; z <= 22; z++) {
      const rn = 2 ** z
      const rows = new Set([0, rn - 1, rn >> 1, (rn >> 1) - 1, 1, rn - 2].filter((y) => y >= 0))
      for (const y of rows) {
        const got = computeRowGeom(z, y)
        const want = inlineRowGeom(z, y)
        expect(got.north, `z${z} y${y} north`).toBe(want.north)
        expect(got.south, `z${z} y${y} south`).toBe(want.south)
        expect(got.mercSouth, `z${z} y${y} mercSouth`).toBe(want.mercSouth)
        expect(got.mercDiff, `z${z} y${y} mercDiff`).toBe(want.mercDiff)
      }
    }
  })

  it('produces a NORTH edge above its SOUTH edge, and a positive span', () => {
    // Orientation, asserted rather than assumed: a sign slip in the transcription
    // above would still be self-consistent between the two implementations, so
    // the differential row cannot catch it. This one can.
    for (const [z, y] of [
      [0, 0],
      [5, 12],
      [9, 198],
      [14, 6000],
      [22, 2_000_000],
    ] as const) {
      const g = computeRowGeom(z, y)
      expect(g.north, `z${z} y${y}`).toBeGreaterThan(g.south)
      expect(g.mercDiff, `z${z} y${y} span`).toBeGreaterThan(0)
    }
  })

  it('is a function of (z, y) only — no x, no world copy', () => {
    // The property that licenses the memo key. It is a tautology of the
    // SIGNATURE, which is exactly the point: the source gate below stops a
    // future edit from reaching for an x it was never given.
    const a = computeRowGeom(9, 198)
    const b = computeRowGeom(9, 198)
    expect(a).toEqual(b)
  })

  it('the cap is a positive integer a viewport cannot reach in one level', () => {
    // A viewport spans well under ten tile rows at any zoom. If this ever drops
    // near that, the memo starts dropping the level it is serving every frame
    // and becomes a pure cost.
    expect(Number.isInteger(ROW_GEOM_MAX_PER_Z)).toBe(true)
    expect(ROW_GEOM_MAX_PER_Z).toBeGreaterThan(32)
  })
})

describe('RowGeomCache — the memo, where the interesting bug lives (#2560)', () => {
  it('serves the same values the pure function computes', () => {
    const c = new RowGeomCache()
    for (const [z, y] of [
      [0, 0],
      [9, 197],
      [9, 198],
      [14, 6001],
    ] as const) {
      expect(c.get(z, y), `z${z} y${y}`).toEqual(computeRowGeom(z, y))
    }
  })

  it('keys on y — adjacent rows do NOT share one answer', () => {
    // THE row. Dropping `y` from the inner key is the plausible mistake, and it
    // is invisible to every test of the pure function: the cache would return
    // row 0's bounds for every row in the level, placing an entire zoom's
    // raster quads at one latitude. Nothing else here can see that.
    const c = new RowGeomCache()
    const a = c.get(9, 198)
    const b = c.get(9, 199)
    expect(a.south).not.toBe(b.south)
    expect(b).toEqual(computeRowGeom(9, 199))
    // and re-reading the first key still gives the FIRST row, not the second
    expect(c.get(9, 198)).toEqual(a)
  })

  it('memoises — a repeat read returns the identical object', () => {
    // Identity, not equality: it is the only way to tell a hit from a recompute
    // that happens to agree, which is what this whole change is for.
    const c = new RowGeomCache()
    expect(c.get(3, 4)).toBe(c.get(3, 4))
  })

  it('zoom levels are independent', () => {
    const c = new RowGeomCache()
    expect(c.get(5, 3).south).not.toBe(c.get(6, 3).south)
  })

  it('drops a level at the cap, and is still correct afterwards', () => {
    // The eviction is wholesale by design. What must survive it is the answer:
    // a dropped row is recomputed, never served stale or absent.
    const c = new RowGeomCache()
    for (let y = 0; y < ROW_GEOM_MAX_PER_Z; y++) c.get(10, y)
    expect(c.sizeAt(10)).toBe(ROW_GEOM_MAX_PER_Z)
    c.get(10, ROW_GEOM_MAX_PER_Z) // trips the cap
    expect(c.sizeAt(10), 'level dropped, then the new row added').toBe(1)
    expect(c.get(10, 7), 'an evicted row recomputes correctly').toEqual(computeRowGeom(10, 7))
  })
})

describe('the row math left the per-tile path (#2560)', () => {
  const RR = readFileSync(join(HERE, 'raster-renderer.ts'), 'utf8')
  const RG = readFileSync(join(HERE, 'raster-row-geom.ts'), 'utf8')

  it('emitTileAt no longer computes the transcendentals inline', () => {
    // The differential rows above pass whether or not the renderer actually
    // CALLS the memo — they test the pure function in isolation. This is the row
    // that fails if the extraction is reverted or the call site drifts back.
    const at = RR.indexOf('const emitTileAt = (')
    expect(at, 'emitTileAt must exist').toBeGreaterThan(-1)
    const body = RR.slice(at, RR.indexOf('\n    }', at))
    expect(body, 'atan/sinh belong to the row memo now').not.toMatch(/Math\.atan\(Math\.sinh/)
    expect(body, 'log/tan likewise').not.toMatch(/Math\.log\(Math\.tan/)
    // Non-vacuity: it reads the memo, and still computes the parts that DO move
    // with x and the world copy.
    expect(body).toMatch(/this\._rowGeom\.get\(renderCoord\.z, renderCoord\.y\)/)
    expect(body).toContain('const west = (ox / rn) * 360 - 180')
  })

  it('the memo key omits x and ox, and the math cannot ask for them', () => {
    // Both halves of the licence in one row: the accessor is keyed (z, y), and
    // the pure function takes nothing else. An x term added to `computeRowGeom`
    // would have to change this signature to compile, which is the point.
    expect(RG).toMatch(/get\(z: number, y: number\): RasterRowGeom/)
    const at = RG.indexOf('export function computeRowGeom(')
    expect(at, 'computeRowGeom must exist').toBeGreaterThan(-1)
    expect(RG.slice(at)).toMatch(/^export function computeRowGeom\(z: number, y: number\)/)
    // Scoped to the BODY, not the file: this module's header explains the memo
    // key by naming the (z, x, y, ox) domain it is narrower than, and a
    // whole-file scan cannot tell that prose from a live term — it would fail
    // for the wrong reason, which is how this row first went red.
    const body = RG.slice(RG.indexOf('{', at), RG.indexOf('\n}', at))
    expect(body, 'the row math has no column input').not.toMatch(/\b(ox|x)\b/)
  })
})
