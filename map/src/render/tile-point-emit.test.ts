// ═══ Fail-before corpus for #2028 — one emission per source point per frame ═══
//
// Drives the REAL production accumulator with a structural fake catalog: no GPU,
// no device, no private-field access, no cast on the fixture itself. That is the
// whole reason the emit body was extracted — inside VectorTileRenderer it sat in
// a private method that `vtr-immediate-arm.test.ts` mocks out entirely, so the
// bug was unreachable from a test.
//
// THE TAG TRICK (from `label-feature-source.test.ts`, which fakes a TileCatalog
// the same way for this same ancestor/descendant duplication class): each tile's
// `featureProps` maps its featId to `{ tag }`, so the sink records WHICH TILE
// emitted each point. Assertions are over `(tag, mercator)` pairs — never over
// `featId`, which is a per-slice INDEX and cannot identify a feature across
// tiles.
//
// Fixture geometry:
//   A  = z11 ancestor, LOADED, holds coarse copies of p1, p2 and p3
//   K2 = z15 descendant of A, LOADED, holds its own fine copy of p2
//   K1 = z15 descendant of A, ABSENT           (the mid-load fallback case)
//   K3 = z15 descendant of A, EMPTY placeholder (present, no pointVertices)

import { describe, expect, it } from 'vitest'
import { tileKey, tileKeyParent } from '@xgis/compiler'
import { EARTH } from '@xgis/shared'
import { accumulateTilePoints } from './tile-point-emit'

const WORLD = 2 * Math.PI * EARTH.sphereR

const split = (v: number): [number, number] => {
  const h = Math.fround(v)
  return [h, Math.fround(v - h)]
}

/** Mercator centre of (z,x,y) — provably interior, far from every edge. */
function centre(z: number, x: number, y: number): [number, number] {
  const e = WORLD / 2 ** z
  return [(x + 0.5) * e - WORLD / 2, WORLD / 2 - (y + 0.5) * e]
}

/** stride-13 record; only feat_id (6) and the Mercator tail (9-12) matter here. */
function rec(fid: number, [mx, my]: [number, number]): number[] {
  const [mxH, mxL] = split(mx)
  const [myH, myL] = split(my)
  return [0, 0, 0, 0, 0, 0, fid, 0, 0, mxH, mxL, myH, myL]
}

function tile(tag: string, recs: number[][]): unknown {
  const props = new Map<number, Record<string, unknown>>()
  for (const r of recs) props.set(r[6]!, { tag })
  return { pointVertices: new Float32Array(recs.flat()), featureProps: props }
}

const catalog = (tiles: Map<number, unknown>): Parameters<typeof accumulateTilePoints>[1] =>
  ({ getTileData: (k: number) => tiles.get(k) ?? null }) as never

/** Collect `tag@roundedMercatorX` per emitted record, in emission order. */
function collect(stableKeys: number[], tiles: Map<number, unknown>): string[] {
  const out: string[] = []
  accumulateTilePoints(stableKeys, catalog(tiles), 'L', true, {
    addTilePoint: (...a: unknown[]) => {
      const n = a as number[]
      const props = a[13] as { tag: string } | null
      out.push(`${props?.tag}@${Math.round(n[9]! + n[10]!)}`)
    },
  } as never)
  return out
}

// Seoul-ish anchors, three horizontal z15 neighbours under one z11 ancestor.
const K1 = tileKey(15, 27968, 12892)
const K2 = tileKey(15, 27969, 12892)
const K3 = tileKey(15, 27970, 12892)
const A = tileKeyParent(tileKeyParent(tileKeyParent(tileKeyParent(K1))))

const p1 = centre(15, 27968, 12892) // inside K1 (absent)
const p2 = centre(15, 27969, 12892) // inside K2 (loaded)
const p3 = centre(15, 27970, 12892) // inside K3 (empty placeholder)

const at = (p: [number, number]): number => Math.round(p[0])

const ancestorTile = (): unknown => tile('A', [rec(0, p1), rec(1, p2), rec(2, p3)])
const k2Tile = (): unknown => tile('K2', [rec(0, p2)])
/** Slice PRESENT, no `pointVertices` — what tile-catalog writes for a tile with
 *  no features, and what tile-decision then issues a parent-fallback for. */
const emptyK3 = (): unknown => ({ featureProps: new Map() })

describe('#2028 — accumulateTilePoints emits each source point once per frame', () => {
  it('the fixture is what it claims: K1/K2/K3 share the ancestor A at z11', () => {
    // An assertion, not an assumption — every case below is scoped by it.
    const up4 = (k: number): number => tileKeyParent(tileKeyParent(tileKeyParent(tileKeyParent(k))))
    expect(up4(K2)).toBe(A)
    expect(up4(K3)).toBe(A)
    expect(A).toBeGreaterThan(1)
  })

  // ─── CAUSE first, then EFFECT (§12: order decides which half a red run accuses) ───

  it('case 5 — a lone primary at the deepest zoom is never gated', () => {
    // The ungated fast path. If this were red, every case below would be
    // measuring a broken accumulator rather than the ownership rule.
    expect(collect([K2], new Map([[K2, k2Tile()]]))).toEqual([`K2@${at(p2)}`])
  })

  it('case 4 — world-copy repeats of the same key emit once', () => {
    const tiles = new Map([
      [K2, k2Tile()],
      [A, ancestorTile()],
    ])
    const once = collect([K2, A], tiles)
    const thrice = collect([K2, K2, K2, A], tiles)
    expect(thrice).toEqual(once)
  })

  it('case 1 — no double over a LOADED child: the descendant wins, the ancestor is shadowed there', () => {
    const out = collect(
      [K1, K2, A],
      new Map([
        [K2, k2Tile()],
        [A, ancestorTile()],
      ]),
    )
    expect(out.filter((s) => s === `K2@${at(p2)}`)).toHaveLength(1)
    expect(out.filter((s) => s === `A@${at(p2)}`)).toHaveLength(0)
  })

  it('case 2 — the MISSING child still gets its points, exactly once (anti-regression)', () => {
    // The requirement that kills a key-level shadow: blanking K1 is the
    // regression, not the fix.
    const out = collect(
      [K1, K2, A],
      new Map([
        [K2, k2Tile()],
        [A, ancestorTile()],
      ]),
    )
    expect(out.filter((s) => s === `A@${at(p1)}`)).toHaveLength(1)
  })

  it('case 3 — an EMPTY placeholder child does NOT suppress its ancestor', () => {
    // `hasTileData` is TRUE for this tile; `pointVertices` is absent. A
    // presence-based supplier test would blank A's points here while A's FILL
    // still drew.
    const out = collect(
      [K3, A],
      new Map([
        [K3, emptyK3()],
        [A, ancestorTile()],
      ]),
    )
    expect(out.filter((s) => s === `A@${at(p3)}`)).toHaveLength(1)
  })

  it('case 8 — a slice that exists only at low zoom is never gated', () => {
    const out = collect([K1, K2, A], new Map([[A, ancestorTile()]]))
    expect(out).toEqual([`A@${at(p1)}`, `A@${at(p2)}`, `A@${at(p3)}`])
  })

  it('case 7 — multi-level fallback keeps the FINEST ancestor, and only it', () => {
    const B = tileKeyParent(tileKeyParent(K1)) // z13, between K1 and A
    const out = collect(
      [K1, B, A],
      new Map([
        [B, tile('B', [rec(0, p1)])],
        [A, ancestorTile()],
      ]),
    )
    expect(out.filter((s) => s.endsWith(`@${at(p1)}`))).toEqual([`B@${at(p1)}`])
  })

  it('case 6 — antimeridian wrap copies are never dropped, even when the seam cell HAS a supplier', () => {
    // The tiler emits wrap COPIES at ±πR and clamps latitude a hair past the
    // polar row edge. Judging those against a clamped edge cell could DROP a
    // point; erring toward emitting leaves only a pre-existing double.
    //
    // This must be built in the WESTMOST column or it proves nothing: a wrap
    // copy at mx = −WORLD/2 computes u = 0 → x = 0, and only a supplier that is
    // ITSELF at x = 0 (and a descendant of the ancestor holding the copy) can
    // make the ungarded predicate gate it. Anchored anywhere else, the seam
    // record is never a candidate for suppression and the case is vacuous with
    // respect to the guard — measured: it passed with the guard removed.
    const KW = tileKey(15, 0, 12880)
    const AW = tileKeyParent(tileKeyParent(tileKeyParent(tileKeyParent(KW))))
    const rowCentre = centre(15, 0, 12880)
    expect(AW).toBeGreaterThan(1)

    const wrapWest: [number, number] = [-WORLD / 2, rowCentre[1]] // u === 0 exactly
    const wrapEast: [number, number] = [WORLD / 2, rowCentre[1]] // u === 1 exactly
    const out = collect(
      [KW, AW],
      new Map([
        [KW, tile('KW', [rec(0, rowCentre)])],
        [AW, tile('AW', [rec(0, wrapWest), rec(1, wrapEast), rec(2, rowCentre)])],
      ]),
    )
    // Both seam copies survive. Without the guard the WEST one is gated by KW's
    // own cell (15, 0, 12880) and disappears.
    expect(out).toContain(`AW@${at(wrapWest)}`)
    expect(out).toContain(`AW@${at(wrapEast)}`)
    // ...and the interior duplicate at KW's centre is still suppressed, so this
    // is not passing by the ownership rule being off altogether.
    expect(out.filter((s) => s === `AW@${at(rowCentre)}`)).toHaveLength(0)
    expect(out).toContain(`KW@${at(rowCentre)}`)
  })
})
