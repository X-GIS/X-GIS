// Unit test for the stateless point-feature packer (#722 S0).
//
// Guards the byte-exact record assembly the inline PointRenderer.uploadLayer
// path delegates to: stride-24 slot placement, world-copy fan-out, quad
// verts/indices, and the translucent back-to-front depth sort. A real-GPU DC=0
// gate covers the full pipeline; this pins the CPU packing contract.

import { describe, it, expect } from 'vitest'
import { lonLatToECEF } from '@xgis/engine'
import {
  packPointInstances,
  POINT_FEAT_STRIDE,
  worldCopyMercX,
  mercXForCopy,
  type TilePointLike,
} from './point-feature-packer'

const S = POINT_FEAT_STRIDE
const DEG2RAD = Math.PI / 180
const R_MERC = 6378137

function makeOut(totalPoints: number, translucent: boolean) {
  const verts = new Float32Array(totalPoints * 4 * 4)
  const u32 = new Uint32Array(verts.buffer)
  const idx = new Uint32Array(totalPoints * 6)
  const feat = new Float32Array(totalPoints * S)
  const depths = translucent ? new Float32Array(totalPoints) : null
  return { verts, u32, idx, feat, depths }
}

// stride-24 source featData with recognisable, f32-exact slot values per point.
function makeSrc(count: number): Float32Array {
  const src = new Float32Array(count * S)
  for (let i = 0; i < count; i++) {
    for (let s = 0; s <= 10; s++) src[i * S + s] = (i + 1) * 100 + s // style slots 0-10
    src[i * S + 19] = i + 1 // shape_id
  }
  return src
}

describe('point-feature-packer', () => {
  it('POINT_FEAT_STRIDE stays 24 (drift sentinel vs point.ts STRIDE)', () => {
    expect(POINT_FEAT_STRIDE).toBe(24)
  })

  it('packs stride-24 records with world-copy fan-out (2 points × 2 copies)', () => {
    const count = 2
    const copies = [0, 1]
    const lons = [10, 20]
    const lats = [30, 40]
    const src = makeSrc(count)
    const out = makeOut(count * copies.length, false)

    const total = packPointInstances(
      {
        count,
        copies,
        isTranslucent: false,
        fwdX: 0,
        fwdY: 0,
        srcFeatData: src,
        position: { kind: 'lonlat', lons, lats },
      },
      out,
    )
    expect(total).toBe(4)

    // Hand-checkable invariants (not a re-derivation of the ECEF/merc math):
    // style slots 0-10 + shape_id copied verbatim, abs lon/lat at 17/18,
    // and each copy fanned out to its own globalIdx = w*count + i.
    for (let w = 0; w < copies.length; w++) {
      for (let i = 0; i < count; i++) {
        const dst = (w * count + i) * S
        for (let s = 0; s <= 10; s++) expect(out.feat[dst + s]).toBe(src[i * S + s])
        expect(out.feat[dst + 17]).toBe(Math.fround(lons[i]))
        expect(out.feat[dst + 18]).toBe(Math.fround(lats[i]))
        expect(out.feat[dst + 19]).toBe(i + 1)
      }
    }

    // World-copy offset: the absolute-Mercator-x (slots 20+21 DSFUN) of the
    // same point shifts by exactly one world-width between copy 0 and copy 1.
    const worldWidth = 360 * DEG2RAD * R_MERC
    const mxCopy0 = out.feat[(0 * count + 0) * S + 20] + out.feat[(0 * count + 0) * S + 21]
    const mxCopy1 = out.feat[(1 * count + 0) * S + 20] + out.feat[(1 * count + 0) * S + 21]
    expect(mxCopy1 - mxCopy0).toBeCloseTo(worldWidth, 0)

    // Byte-exact against an independent reference packing (same formulas) —
    // catches slot-offset / fan-out-index / fround regressions.
    const refFeat = new Float32Array(4 * S)
    const refVerts = new Float32Array(4 * 16)
    const refU32 = new Uint32Array(refVerts.buffer)
    const refIdx = new Uint32Array(4 * 6)
    for (let w = 0; w < copies.length; w++) {
      for (let i = 0; i < count; i++) {
        const gI = w * count + i
        const lon = lons[i],
          lat = lats[i]
        const ecef = lonLatToECEF(lon, lat)
        const exH = Math.fround(ecef[0])
        const exL = ecef[0] - exH
        const eyH = Math.fround(ecef[1])
        const eyL = ecef[1] - eyH
        const ezH = Math.fround(ecef[2])
        const ezL = ecef[2] - ezH
        const dst = gI * S
        refFeat.set(src.subarray(i * S, i * S + 11), dst)
        refFeat[dst + 11] = exH
        refFeat[dst + 12] = eyH
        refFeat[dst + 13] = ezH
        refFeat[dst + 14] = exL
        refFeat[dst + 15] = eyL
        refFeat[dst + 16] = ezL
        refFeat[dst + 17] = lon
        refFeat[dst + 18] = lat
        refFeat[dst + 19] = src[i * S + 19]
        const mx = worldCopyMercX(lon, copies[w])
        const myC = Math.max(-85.051129, Math.min(85.051129, lat))
        const my = Math.log(Math.tan(Math.PI / 4 + (myC * DEG2RAD) / 2)) * R_MERC
        const mxH = Math.fround(mx)
        const myH = Math.fround(my)
        refFeat[dst + 20] = mxH
        refFeat[dst + 21] = Math.fround(mx - mxH)
        refFeat[dst + 22] = myH
        refFeat[dst + 23] = Math.fround(my - myH)
        const vBase = gI * 16
        for (let q = 0; q < 4; q++) {
          const off = vBase + q * 4
          refVerts[off] = 0
          refVerts[off + 1] = 0
          refU32[off + 2] = q
          refVerts[off + 3] = gI
        }
        const iBase = gI * 6,
          vIdx = gI * 4
        refIdx[iBase] = vIdx
        refIdx[iBase + 1] = vIdx + 1
        refIdx[iBase + 2] = vIdx + 2
        refIdx[iBase + 3] = vIdx
        refIdx[iBase + 4] = vIdx + 2
        refIdx[iBase + 5] = vIdx + 3
      }
    }
    expect(Array.from(out.feat)).toEqual(Array.from(refFeat))
    expect(Array.from(out.verts)).toEqual(Array.from(refVerts))
    expect(Array.from(out.idx)).toEqual(Array.from(refIdx))
  })

  it('opaque layers keep feature-order indices', () => {
    const count = 3
    const src = makeSrc(count)
    const out = makeOut(count, false)
    packPointInstances(
      {
        count,
        copies: [0],
        isTranslucent: false,
        fwdX: 0.3,
        fwdY: -0.7,
        srcFeatData: src,
        position: { kind: 'lonlat', lons: [0, 10, -10], lats: [0, 45, -45] },
      },
      out,
    )
    expect(out.depths).toBeNull()
    for (let gI = 0; gI < count; gI++) {
      const iBase = gI * 6,
        vIdx = gI * 4
      expect(Array.from(out.idx.subarray(iBase, iBase + 6))).toEqual([
        vIdx,
        vIdx + 1,
        vIdx + 2,
        vIdx,
        vIdx + 2,
        vIdx + 3,
      ])
    }
  })

  it('translucent layers emit indices back-to-front (largest depth first)', () => {
    const count = 3
    const lons = [0, 10, -10]
    const lats = [0, 45, -45]
    const fwdX = 0.3,
      fwdY = -0.7
    const src = makeSrc(count)
    const out = makeOut(count, true)

    packPointInstances(
      {
        count,
        copies: [0],
        isTranslucent: true,
        fwdX,
        fwdY,
        srcFeatData: src,
        position: { kind: 'lonlat', lons, lats },
      },
      out,
    )
    expect(out.depths).not.toBeNull()

    // depth[gI] = fround(ecef.x)*fwdX + fround(ecef.y)*fwdY (stored f32).
    const depthKey = (gI: number): number => {
      const ecef = lonLatToECEF(lons[gI], lats[gI])
      return Math.fround(ecef[0]) * fwdX + Math.fround(ecef[1]) * fwdY
    }
    for (let gI = 0; gI < count; gI++) {
      expect(out.depths![gI]).toBe(Math.fround(depthKey(gI)))
    }

    // Draw order: idx[p*6] = drawGlobalIdx*4 → recover the emit order.
    const drawOrder: number[] = []
    for (let p = 0; p < count; p++) drawOrder.push(out.idx[p * 6] / 4)
    // Permutation of [0..count).
    expect([...drawOrder].sort((a, b) => a - b)).toEqual([0, 1, 2])
    // Back-to-front: depth non-increasing along the emit order.
    for (let p = 1; p < count; p++) {
      expect(out.depths![drawOrder[p - 1]]).toBeGreaterThanOrEqual(out.depths![drawOrder[p]])
    }
  })
})

// ── #722 S1 — Mercator-x world-copy re-split for the pre-split (tile) path ──

/** Split an f64 into an f32 DSFUN (hi, lo) pair — mirrors the compiler's
 *  `splitF64` (ecef-packing.ts) so the tile points below carry the SAME
 *  precision the real tiler emits. */
function split(x: number): [number, number] {
  const h = Math.fround(x)
  return [h, Math.fround(x - h)]
}

/** Build a pre-split tile point for `lon`/`lat` with the compiler's DSFUN
 *  precision (Float32Array round-trips guarantee f32 slot values). */
function makeTilePoint(lon: number, lat: number): TilePointLike {
  const ecef = lonLatToECEF(lon, lat)
  const [exH, exL] = split(ecef[0])
  const [eyH, eyL] = split(ecef[1])
  const [ezH, ezL] = split(ecef[2])
  const mx = lon * DEG2RAD * R_MERC
  const myC = Math.max(-85.051129, Math.min(85.051129, lat))
  const my = Math.log(Math.tan(Math.PI / 4 + (myC * DEG2RAD) / 2)) * R_MERC
  const [mxH, mxL] = split(mx)
  const [myH, myL] = split(my)
  return { exH, eyH, ezH, exL, eyL, ezL, absLon: lon, absLat: lat, mxH, mxL, myH, myL }
}

describe('mercXForCopy (#722 S1 — tile world-copy Mercator-x)', () => {
  it('reconstructs worldCopyMercX for a sample lon across wo ∈ {-1,0,1}', () => {
    const lon = 126.977 // Seoul
    const [mxH, mxL] = split(lon * DEG2RAD * R_MERC)
    for (const wo of [-1, 0, 1]) {
      const [hi, lo] = mercXForCopy(mxH, mxL, wo)
      // The reconstructed hi+lo must match worldCopyMercX(lon, wo) — the
      // formula the inline path uses — so inline and tile agree per copy.
      expect(hi + lo).toBeCloseTo(worldCopyMercX(lon, wo), 3)
    }
  })

  it('wo=0 round-trips the input DSFUN pair byte-identically', () => {
    // Guards the high-zoom (single-copy) tile path staying byte-identical to
    // the legacy direct `featData[..]=pt.mxH/mxL` write.
    for (const lon of [0, 45, -73.5, 126.977, 179.9, -179.9]) {
      const [mxH, mxL] = split(lon * DEG2RAD * R_MERC)
      expect(mercXForCopy(mxH, mxL, 0)).toEqual([mxH, mxL])
    }
  })
})

describe('point-feature-packer — presplit (tile) position source', () => {
  it('fans out N presplit points × copies; ECEF/abs pass through, Mercator-x shifts per copy', () => {
    const count = 2
    const copies = [0, 1, -1]
    const pts = [makeTilePoint(10, 30), makeTilePoint(-120, -45)]
    const src = makeSrc(count) // style slots 0-10 + shape_id at 19
    const out = makeOut(count * copies.length, false)

    const total = packPointInstances(
      {
        count,
        copies,
        isTranslucent: false,
        fwdX: 0,
        fwdY: 0,
        srcFeatData: src,
        position: { kind: 'presplit', points: pts },
      },
      out,
    )
    expect(total).toBe(count * copies.length) // 6 records — the fan-out

    const worldWidth = 360 * DEG2RAD * R_MERC
    for (let w = 0; w < copies.length; w++) {
      for (let i = 0; i < count; i++) {
        const dst = (w * count + i) * S
        const pt = pts[i]
        // Style slots 0-10 + shape_id copied verbatim from the per-point source.
        for (let s = 0; s <= 10; s++) expect(out.feat[dst + s]).toBe(src[i * S + s])
        expect(out.feat[dst + 19]).toBe(src[i * S + 19])
        // ECEF (11-16) + abs lon/lat (17-18) are copy-INDEPENDENT — every copy
        // holds the primary point's absolute position unchanged.
        expect(out.feat[dst + 11]).toBe(pt.exH)
        expect(out.feat[dst + 14]).toBe(pt.exL)
        expect(out.feat[dst + 17]).toBe(Math.fround(pt.absLon))
        expect(out.feat[dst + 18]).toBe(Math.fround(pt.absLat))
        // Mercator-y (22-23) copy-independent; Mercator-x (20-21) = primary + wo·width.
        expect(out.feat[dst + 22]).toBe(pt.myH)
        expect(out.feat[dst + 23]).toBe(pt.myL)
        const mx = out.feat[dst + 20] + out.feat[dst + 21]
        const mx0 = out.feat[i * S + 20] + out.feat[i * S + 21] // same point, copy 0
        expect(mx - mx0).toBeCloseTo(copies[w] * worldWidth, 0)
      }
    }
  })

  it('wo=0 presplit output is byte-identical to the legacy direct tile write', () => {
    const count = 3
    const pts = [makeTilePoint(0, 0), makeTilePoint(126.977, 37.5), makeTilePoint(-120, -45)]
    const src = makeSrc(count)
    const out = makeOut(count, false)
    packPointInstances(
      {
        count,
        copies: [0],
        isTranslucent: false,
        fwdX: 0,
        fwdY: 0,
        srcFeatData: src,
        position: { kind: 'presplit', points: pts },
      },
      out,
    )
    // Independent reference = the pre-#722 flushTilePoints inline write.
    for (let i = 0; i < count; i++) {
      const dst = i * S
      const pt = pts[i]
      expect(out.feat[dst + 11]).toBe(pt.exH)
      expect(out.feat[dst + 12]).toBe(pt.eyH)
      expect(out.feat[dst + 13]).toBe(pt.ezH)
      expect(out.feat[dst + 14]).toBe(pt.exL)
      expect(out.feat[dst + 15]).toBe(pt.eyL)
      expect(out.feat[dst + 16]).toBe(pt.ezL)
      expect(out.feat[dst + 20]).toBe(pt.mxH)
      expect(out.feat[dst + 21]).toBe(pt.mxL)
      expect(out.feat[dst + 22]).toBe(pt.myH)
      expect(out.feat[dst + 23]).toBe(pt.myL)
    }
  })
})
