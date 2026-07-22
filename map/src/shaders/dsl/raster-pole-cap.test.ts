// ═══ #1053 — raster globe pole cap: CPU-level mesh gates ═══
//
// The globe raster surface is a per-tile Web-Mercator grid that saturates at
// ±85.0511° (raster-renderer.ts bounds + the merc_y clamp), leaving an open
// polar hole above/below that ring. This suite pins the fix — a triangle fan
// per pole that reuses the raster material (vs_tile) with texture V clamped to
// the band edge and the vertices fanned to the geographic pole — at the CPU
// level, GPU-free.
//
// SINGLE AUTHORITY: the cap latitude / V / cull-edge math lives in ONE place,
// the `raster_cap_params` DSL fn (raster.ts), which BOTH emits to WGSL/GLSL
// (vs_tile calls it) AND is CPU-evaluated here via compileModule — so these
// gates test the exact math the shader runs, not a hand mirror.

import { describe, it, expect } from 'vitest'
import { module, compileModule } from '@xgis/shader-dsl'
import { uniformBlock } from '@xgis/engine'
import { lonLatToECEF } from '@xgis/shared'
import { rasterCapParams, rasterTileU as RASTER_TILE_U } from './raster'
import {
  needsNorthPoleCap,
  needsSouthPoleCap,
  writeRasterTileUniform,
} from '../../render/raster-renderer'
import { PROJECTION_CONSTS } from './projections'

// The z0 globe tile's Mercator band spans the full ±85.0511° extent, i.e.
// merc_y ∈ [−π, +π] in the shader's unscaled log(tan(π/4+lat/2)) units.
const MERC_S = -Math.PI
const MERC_DIFF = 2 * Math.PI
const POLE_LAT_RAD = Math.PI / 2
const BAND_EDGE_LAT_RAD = 2 * Math.atan(Math.exp(Math.PI)) - Math.PI / 2 // ≈ 1.48442 (85.0511°)
// WGS84 semi-minor axis — z at the geographic pole (lonLatToECEF(lon, ±90)).
const WGS84_B = 6356752.314245179

const M = compileModule(module({ consts: PROJECTION_CONSTS, funcs: [rasterCapParams] }))
/** CPU-eval the cap params fn → [capLatRad, capV, edgeMercY]. */
function capParams(vv: number, capSign: number): [number, number, number] {
  return M.fns.raster_cap_params(vv, MERC_S, MERC_DIFF, capSign) as [number, number, number]
}

const NORTH = 1
const SOUTH = -1

describe('#1053 raster pole cap — latitude converges to the geographic pole', () => {
  it('NORTH cap: the pole row (vv=0) reaches exactly +90° (π/2 rad)', () => {
    const [lat] = capParams(0, NORTH)
    expect(lat).toBeCloseTo(POLE_LAT_RAD, 9)
  })
  it('SOUTH cap: the pole row (vv=1) reaches exactly −90° (−π/2 rad)', () => {
    // increasing vv is southward, so the south pole is the max-vv row.
    const [lat] = capParams(1, SOUTH)
    expect(lat).toBeCloseTo(-POLE_LAT_RAD, 9)
  })
  it('NORTH cap: the band-edge row (vv=1) matches the tile’s +85.0511° edge exactly', () => {
    // Crack-free by construction — the edge lat is reconstructed from the SAME
    // merc_y the ground tile uses (merc_south + merc_diff), not an independent
    // literal, so the cap ring coincides with the tile’s north edge.
    const [lat] = capParams(1, NORTH)
    expect(lat).toBeCloseTo(BAND_EDGE_LAT_RAD, 9)
  })
  it('SOUTH cap: the band-edge row (vv=0) matches the tile’s −85.0511° edge exactly', () => {
    const [lat] = capParams(0, SOUTH)
    expect(lat).toBeCloseTo(-BAND_EDGE_LAT_RAD, 9)
  })
  it('cap latitude is monotonic from band edge to pole across the rows', () => {
    // NORTH: vv 1→0 climbs 85.05°→90°; every interior row stays within the band.
    let prev = capParams(1, NORTH)[0]
    for (let k = 9; k >= 0; k--) {
      const lat = capParams(k / 10, NORTH)[0]
      expect(lat).toBeGreaterThanOrEqual(prev - 1e-9)
      expect(lat).toBeLessThanOrEqual(POLE_LAT_RAD + 1e-9)
      prev = lat
    }
  })
})

describe('#1053 raster pole cap — ring converges to the ECEF pole (0,0,±b)', () => {
  it('NORTH pole-row vertices at every longitude collapse to (0,0,+b)', () => {
    const [lat] = capParams(0, NORTH)
    const latDeg = (lat * 180) / Math.PI
    for (const lon of [-180, -90, 0, 37.5, 90, 179.9]) {
      const [x, y, z] = lonLatToECEF(lon, latDeg)
      expect(Math.hypot(x, y)).toBeLessThan(1e-3) // sub-mm off the polar axis
      expect(z).toBeCloseTo(WGS84_B, 2)
    }
  })
  it('SOUTH pole-row vertices collapse to (0,0,−b)', () => {
    const [lat] = capParams(1, SOUTH)
    const latDeg = (lat * 180) / Math.PI
    for (const lon of [-180, 0, 90]) {
      const [x, y, z] = lonLatToECEF(lon, latDeg)
      expect(Math.hypot(x, y)).toBeLessThan(1e-3)
      expect(z).toBeCloseTo(-WGS84_B, 2)
    }
  })
})

describe('#1053 raster pole cap — texture V clamps to the Mercator band edge', () => {
  it('NORTH cap V ≡ 0 (topmost texel row) for every row vv', () => {
    for (const vv of [0, 0.25, 0.5, 0.75, 1]) expect(capParams(vv, NORTH)[1]).toBe(0)
  })
  it('SOUTH cap V ≡ 1 (bottommost texel row) for every row vv', () => {
    for (const vv of [0, 0.25, 0.5, 0.75, 1]) expect(capParams(vv, SOUTH)[1]).toBe(1)
  })
  it('the cull-edge merc_y is the CLAMPED band edge (±π), not the pole', () => {
    // The fragment hemisphere cull reads abs_merc_y; the cap feeds it the band
    // edge (the pole is not Mercator-representable), mirroring the vector caps.
    expect(capParams(0, NORTH)[2]).toBeCloseTo(Math.PI, 9)
    expect(capParams(0.5, NORTH)[2]).toBeCloseTo(Math.PI, 9)
    expect(capParams(0, SOUTH)[2]).toBeCloseTo(-Math.PI, 9)
  })
})

describe('#1053 raster pole cap — winding matches the surface (no backface hole)', () => {
  // vs_tile’s procedural cell decode (duArr/dvArr) — replicated so the winding
  // gate exercises the SAME triangle vertex ordering the shader emits.
  const DU = [0, 1, 0, 1, 1, 0]
  const DV = [0, 0, 1, 0, 1, 1]
  const N = 8
  const WEST = -180
  const EAST = 180

  /** ECEF of grid vertex (gx,gy) given a vv→latitude(rad) map. */
  function vert(gx: number, gy: number, latOfVv: (vv: number) => number): number[] {
    const uu = gx / N
    const vv = gy / N
    const lon = WEST + (EAST - WEST) * uu
    const latDeg = (latOfVv(vv) * 180) / Math.PI
    return lonLatToECEF(lon, latDeg) as unknown as number[]
  }
  const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
  const cross = (a: number[], b: number[]) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ]
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

  /** Sign of triangle-normal · outward-radial for cell (cx,cy)’s first triangle. */
  function facingSign(cx: number, cy: number, latOfVv: (vv: number) => number): number {
    const p = [0, 1, 2].map((t) => vert(cx + DU[t], cy + DV[t], latOfVv))
    const n = cross(sub(p[1], p[0]), sub(p[2], p[0]))
    const c = [
      (p[0][0] + p[1][0] + p[2][0]) / 3,
      (p[0][1] + p[1][1] + p[2][1]) / 3,
      (p[0][2] + p[1][2] + p[2][2]) / 3,
    ]
    return Math.sign(dot(n, c))
  }

  // Reference surface (normal grid) latitude map: merc reconstruct, north band.
  const surfaceLat = (vv: number) =>
    2 * Math.atan(Math.exp(MERC_S + (1 - vv) * MERC_DIFF)) - Math.PI / 2
  const capLatN = (vv: number) => capParams(vv, NORTH)[0]

  it('NORTH cap cells face the SAME way as the surface grid cells (outward)', () => {
    const surf = facingSign(3, 3, surfaceLat)
    expect(surf).not.toBe(0)
    for (const [cx, cy] of [
      [0, 1],
      [3, 4],
      [7, 7],
      [0, 7],
    ]) {
      expect(facingSign(cx, cy, capLatN), `cap cell ${cx},${cy}`).toBe(surf)
    }
  })
})

describe('#1053 raster pole cap — present on the globe, ABSENT on the flat path', () => {
  const GLOBE = 7
  it('flat/mercator + all non-globe projTypes never cap (byte-identical plane)', () => {
    for (const projType of [0, 1, 2, 3, 4, 5, 6]) {
      expect(needsNorthPoleCap(projType, 0)).toBe(false)
      expect(needsSouthPoleCap(projType, 3, 4)).toBe(false)
    }
  })
  it('globe caps ONLY the topmost (y=0) and bottommost (y=2^z−1) tile rows', () => {
    expect(needsNorthPoleCap(GLOBE, 0)).toBe(true)
    expect(needsNorthPoleCap(GLOBE, 1)).toBe(false)
    // z=2 → 4 tiles per axis; y=3 is the south edge, y=0 the north edge.
    expect(needsSouthPoleCap(GLOBE, 3, 4)).toBe(true)
    expect(needsSouthPoleCap(GLOBE, 0, 4)).toBe(false)
    // A z0 single-tile world is BOTH the top and bottom row → both caps.
    expect(needsNorthPoleCap(GLOBE, 0)).toBe(true)
    expect(needsSouthPoleCap(GLOBE, 0, 1)).toBe(true)
  })
})

describe('#1053 raster pole cap — capSign packs into TileUniforms.grid.y', () => {
  // The cap "tile" reuses the per-tile uniform; the cap sign rides the formerly
  // reserved grid.y lane (slot 11). capSign follows the new tileOpacity arg
  // (default 1) and itself defaults to 0, so a normal tile still packs grid.y = 0.
  const ECEF_SW: readonly [number, number, number] = [4187345.1, -832901.7, 4732081.9]
  const packGridY = (capSign?: number): number => {
    const block = uniformBlock(RASTER_TILE_U)
    writeRasterTileUniform(
      block,
      -180,
      -85,
      180,
      85,
      ECEF_SW,
      -Math.PI,
      2 * Math.PI,
      64,
      1,
      capSign,
    )
    return new Float32Array(block.buffer)[11]! // grid.y
  }
  it('omitted capSign → grid.y = 0 (normal tile, byte-identical)', () => {
    expect(packGridY(undefined)).toBe(0)
  })
  it('north cap (+1) / south cap (−1) land in grid.y', () => {
    expect(packGridY(1)).toBe(1)
    expect(packGridY(-1)).toBe(-1)
  })
})

describe('raster tile fade — per-tile opacity packs into tile_ecef_center.w (slot 7)', () => {
  // The FS multiplies the sampled alpha by this lane (via the vis varying) so a
  // freshly-appeared tile cross-fades 0→1 over its parent. Default 1 = full.
  const ECEF_SW: readonly [number, number, number] = [4187345.1, -832901.7, 4732081.9]
  const packOpacity = (tileOpacity?: number): number => {
    const block = uniformBlock(RASTER_TILE_U)
    writeRasterTileUniform(
      block,
      -180,
      -85,
      180,
      85,
      ECEF_SW,
      -Math.PI,
      2 * Math.PI,
      64,
      tileOpacity,
    )
    return new Float32Array(block.buffer)[7]! // tile_ecef_center.w
  }
  it('omitted → 1 (fully shown, the instant/pre-fade default)', () => {
    expect(packOpacity(undefined)).toBe(1)
  })
  it('a mid-fade alpha rides slot 7 verbatim (the shader multiplies the texel alpha by it)', () => {
    expect(packOpacity(0)).toBe(0) // fade just started → tile transparent, parent shows
    expect(packOpacity(0.5)).toBeCloseTo(0.5, 6)
    expect(packOpacity(1)).toBe(1)
  })
})
