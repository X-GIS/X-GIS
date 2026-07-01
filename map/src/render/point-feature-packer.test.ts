// Unit test for the stateless point-feature packer (#722 S0).
//
// Guards the byte-exact record assembly the inline PointRenderer.uploadLayer
// path delegates to: stride-24 slot placement, world-copy fan-out, quad
// verts/indices, and the translucent back-to-front depth sort. A real-GPU DC=0
// gate covers the full pipeline; this pins the CPU packing contract.

import { describe, it, expect } from 'vitest'
import { lonLatToECEF } from '@xgis/engine'
import { packPointInstances, POINT_FEAT_STRIDE, worldCopyMercX } from './point-feature-packer'

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
      { count, copies, isTranslucent: false, fwdX: 0, fwdY: 0, srcFeatData: src, lons, lats },
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
        const lon = lons[i], lat = lats[i]
        const ecef = lonLatToECEF(lon, lat)
        const exH = Math.fround(ecef[0]); const exL = ecef[0] - exH
        const eyH = Math.fround(ecef[1]); const eyL = ecef[1] - eyH
        const ezH = Math.fround(ecef[2]); const ezL = ecef[2] - ezH
        const dst = gI * S
        refFeat.set(src.subarray(i * S, i * S + 11), dst)
        refFeat[dst + 11] = exH; refFeat[dst + 12] = eyH; refFeat[dst + 13] = ezH
        refFeat[dst + 14] = exL; refFeat[dst + 15] = eyL; refFeat[dst + 16] = ezL
        refFeat[dst + 17] = lon; refFeat[dst + 18] = lat
        refFeat[dst + 19] = src[i * S + 19]
        const mx = worldCopyMercX(lon, copies[w])
        const myC = Math.max(-85.051129, Math.min(85.051129, lat))
        const my = Math.log(Math.tan(Math.PI / 4 + myC * DEG2RAD / 2)) * R_MERC
        const mxH = Math.fround(mx); const myH = Math.fround(my)
        refFeat[dst + 20] = mxH; refFeat[dst + 21] = Math.fround(mx - mxH)
        refFeat[dst + 22] = myH; refFeat[dst + 23] = Math.fround(my - myH)
        const vBase = gI * 16
        for (let q = 0; q < 4; q++) {
          const off = vBase + q * 4
          refVerts[off] = 0; refVerts[off + 1] = 0; refU32[off + 2] = q; refVerts[off + 3] = gI
        }
        const iBase = gI * 6, vIdx = gI * 4
        refIdx[iBase] = vIdx; refIdx[iBase + 1] = vIdx + 1; refIdx[iBase + 2] = vIdx + 2
        refIdx[iBase + 3] = vIdx; refIdx[iBase + 4] = vIdx + 2; refIdx[iBase + 5] = vIdx + 3
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
      { count, copies: [0], isTranslucent: false, fwdX: 0.3, fwdY: -0.7, srcFeatData: src, lons: [0, 10, -10], lats: [0, 45, -45] },
      out,
    )
    expect(out.depths).toBeNull()
    for (let gI = 0; gI < count; gI++) {
      const iBase = gI * 6, vIdx = gI * 4
      expect(Array.from(out.idx.subarray(iBase, iBase + 6)))
        .toEqual([vIdx, vIdx + 1, vIdx + 2, vIdx, vIdx + 2, vIdx + 3])
    }
  })

  it('translucent layers emit indices back-to-front (largest depth first)', () => {
    const count = 3
    const lons = [0, 10, -10]
    const lats = [0, 45, -45]
    const fwdX = 0.3, fwdY = -0.7
    const src = makeSrc(count)
    const out = makeOut(count, true)

    packPointInstances(
      { count, copies: [0], isTranslucent: true, fwdX, fwdY, srcFeatData: src, lons, lats },
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
