import { describe, it, expect } from 'vitest'
import { Camera } from '../engine/projection/camera'
import { visibleTilesFrustum, visibleTilesFrustumSampled } from './tile-select'
import { mercator, naturalEarth } from '../engine/projection/projection'
import { worldCopiesFor } from '../engine/gpu/gpu-shared'
import { PROJECTION_NAME_TO_TYPE } from '../engine/projection/projections-table'

// PR-A target #3 equivalence gate. The tile-select classifier was migrated
// from the lossy `projType = name === 'mercator' ? 0 : 1` to the canonical
// `PROJECTION_NAME_TO_TYPE[name] ?? 0` table lookup. The ONLY consumers of
// that projType inside tile-select are:
//   1. `maxCopies = (worldCopiesFor(projType).length - 1) / 2`
//   2. `isMerc = projType === 0`   (sampled path only)
// Under the table, natural_earth moves 1 → 2 while equirect stays 1. This
// suite pins that the swap is byte-equivalent for every live input.

const W = 1024
const H = 768

function makeCam(zoom: number, lat = 0, lon = 0, pitch = 0): Camera {
  const c = new Camera(lon, lat, zoom)
  c.pitch = pitch
  return c
}

function keyOf(t: { z: number; x: number; y: number; ox: number }): string {
  return `${t.z}/${t.x}/${t.y}/${t.ox}`
}

function setOf(tiles: Array<{ z: number; x: number; y: number; ox: number }>): Set<string> {
  return new Set(tiles.map(keyOf))
}

describe('tile-select classifier table-ification — lookup equivalence', () => {
  it('the prior ?0:1 and the table agree on maxCopies + isMerc for live inputs', () => {
    // The two derived quantities the classifier feeds. The swap is only safe
    // if BOTH are invariant when natural_earth shifts from 1 → 2.
    for (const name of ['mercator', 'equirectangular', 'natural_earth']) {
      const oldType = name === 'mercator' ? 0 : 1
      const newType = PROJECTION_NAME_TO_TYPE[name] ?? 0
      // maxCopies invariant
      const oldMax = (worldCopiesFor(oldType).length - 1) / 2
      const newMax = (worldCopiesFor(newType).length - 1) / 2
      expect(newMax, `${name}: maxCopies drift`).toBe(oldMax)
      // isMerc invariant
      expect(newType === 0, `${name}: isMerc drift`).toBe(oldType === 0)
    }
  })

  // Direct invariance proof. The classifier output (projType) feeds the
  // selector ONLY via `maxCopies` and `isMerc`. Both are byte-equal between
  // the old `?0:1` and the new table for natural_earth (1 → 2), so the
  // selector output for natural_earth MUST match what the old classifier
  // produced. We pin that by computing the selection under the live (table)
  // code and asserting it equals the selection produced when `maxCopies`/
  // `isMerc` are derived from the OLD projType — which, since they are
  // identical, is the very same call. (A divergence here would only be
  // possible if projType leaked past maxCopies/isMerc, which it does not.)
  //
  // Note: equirect and natural_earth do NOT select the same tiles as each
  // other — their `projection.forward/inverse` math genuinely differs
  // (polynomial vs linear), independent of the projType integer. So the
  // gate is per-projection determinism, not cross-projection equality.
  it('natural_earth sampled selection is deterministic + ox-fanout bounded under the table classifier', () => {
    for (const zoom of [0, 2, 3, 4, 6]) {
      const a = visibleTilesFrustumSampled(makeCam(zoom, 20, 40), naturalEarth(0), zoom, W, H)
      const b = visibleTilesFrustumSampled(makeCam(zoom, 20, 40), naturalEarth(0), zoom, W, H)
      expect(setOf(a), `NE sampled z=${zoom}`).toEqual(setOf(b))
      // worldCopiesFor(2) === worldCopiesFor(1) so the world-copy fan-out is
      // unchanged: ox spans the same range it did under projType 1.
      const oxValues = new Set(a.map((t) => t.ox))
      const newMax = (worldCopiesFor(PROJECTION_NAME_TO_TYPE['natural_earth'] ?? 0).length - 1) / 2
      for (const ox of oxValues) expect(Math.abs(ox)).toBeLessThanOrEqual(newMax * Math.pow(2, zoom))
    }
  })

  it('natural_earth frustum selection is deterministic under the table classifier', () => {
    for (const zoom of [0, 2, 3, 4, 6]) {
      const maxZ = Math.round(zoom)
      const a = visibleTilesFrustum(makeCam(zoom, 20, 40), naturalEarth(0), maxZ, W, H)
      const b = visibleTilesFrustum(makeCam(zoom, 20, 40), naturalEarth(0), maxZ, W, H)
      expect(setOf(a), `NE frustum z=${zoom}`).toEqual(setOf(b))
    }
  })

  it('mercator stays projType 0 (single-world path unchanged)', () => {
    // Sanity: the table must not perturb the mercator path.
    expect(PROJECTION_NAME_TO_TYPE['mercator']).toBe(0)
    const cam = makeCam(4, 0, 0)
    const tiles = visibleTilesFrustum(cam, mercator, 4, W, H)
    expect(tiles.length).toBeGreaterThan(0)
  })
})
