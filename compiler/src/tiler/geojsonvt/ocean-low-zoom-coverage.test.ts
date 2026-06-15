// #360 F2 gate: enclosed seas + sub-clamp Arctic must stay COVERED at low zoom.
//
// THE BUG: at low zoom (z0-3) the per-zoom Douglas-Peucker tolerance
// (tile.ts:17) is large enough that the world-ocean ring's narrow inlets
// (Gibraltar→Mediterranean, Black Sea, Caspian, Guinea coast) and the
// sub-85° Arctic get straightened away — the ring chord cuts across the
// inlet mouth, EXCLUDING the sea, which then renders clear/BLACK (oracle
// A/C violation; confirmed real-GPU + raw point-in-polygon, 2026-06-15).
//
// THE FIX: tile.ts forces tolerance=0 for z <= LOW_ZOOM_NO_SIMPLIFY (full
// fidelity at world zooms). z >= that+1 keep the zoom-scaled tolerance
// (byte-identical), and maxZoom was already tolerance=0.
//
// VERIFIED ROOT (tolerance bisect, this file's earlier probe): every point
// below is a HOLE at the prod default tolerance:6 and COVERED at tolerance:0
// for z<=3 — so the fix (force 0 at low zoom) is exactly what closes them.
// Interior sample points (away from lon 0/±180 + tile-y edges) keep the
// extent-space PIP robust.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { GeoJSONVT } from './index'

const here = dirname(fileURLToPath(import.meta.url))
const oceanPath = resolve(here, '../../../../playground/public/data/ne_110m_ocean.geojson')
const ocean = JSON.parse(readFileSync(oceanPath, 'utf8'))

const EXTENT = 8192
const projX = (lon: number) => lon / 360 + 0.5
const projY = (lat: number) => {
  const s = Math.sin((lat * Math.PI) / 180)
  const y = 0.5 - (0.25 * Math.log((1 + s) / (1 - s))) / Math.PI
  return y < 0 ? 0 : y > 1 ? 1 : y
}
function inRing(px: number, py: number, ring: number[][]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i]![0]!, yi = ring[i]![1]!, xj = ring[j]![0]!, yj = ring[j]![1]!
    if (((yi > py) !== (yj > py)) && (px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)) inside = !inside
  }
  return inside
}
// Is (lon,lat) covered by the tiled ocean polygon at zoom z?
function covered(idx: InstanceType<typeof GeoJSONVT>, lon: number, lat: number, z: number): boolean {
  const z2 = 1 << z
  const tx = Math.floor(projX(lon) * z2), ty = Math.floor(projY(lat) * z2)
  const ex = Math.round(EXTENT * (projX(lon) * z2 - tx))
  const ey = Math.round(EXTENT * (projY(lat) * z2 - ty))
  const tile = idx.getTile(z, tx, ty) as { features?: Array<{ type: number; geometry: number[][][] }> } | null
  if (!tile?.features?.length) return false
  for (const f of tile.features) {
    if (f.type !== 3) continue
    let c = false
    for (const ring of f.geometry) if (inRing(ex, ey, ring)) c = !c
    if (c) return true
  }
  return false
}

// Interior points inside genuinely-ocean enclosed seas (raw-PIP confirmed ocean).
const SEAS: Array<[string, number, number]> = [
  ['Mediterranean', 18, 34],
  ['BlackSea', 35, 43],
  ['Caspian', 50, 42],
  ['Arctic(sub-85)', 30, 80],
]
const CONTROL_OCEAN: [string, number, number] = ['Pacific', -160, 0]

describe('#360 F2 — enclosed seas + sub-clamp Arctic covered at low zoom (default options)', () => {
  // DEFAULT options (tolerance:6) — exercises the fix's low-zoom floor.
  const idx = new GeoJSONVT(ocean)

  it('control open-ocean is covered z0-3 (validates the coverage probe)', () => {
    for (let z = 0; z <= 3; z++) {
      expect(covered(idx, CONTROL_OCEAN[1], CONTROL_OCEAN[2], z), `${CONTROL_OCEAN[0]} z${z}`).toBe(true)
    }
  })

  for (const [name, lon, lat] of SEAS) {
    it(`${name} is covered at z0-3 (FAILS pre-fix: low-zoom simplify drops it)`, () => {
      for (let z = 0; z <= 3; z++) {
        expect(covered(idx, lon, lat, z), `${name} must be COVERED (sky-900) at z${z}`).toBe(true)
      }
    })
  }
})
