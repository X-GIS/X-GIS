// ═══ Raster uniform byte-equality gate (#733 P2b) ═══
//
// Contracts:
//   1. MAIN PATH — writeRasterFrameUniform's block bytes ≡ the retired render()
//      slot writer (frozen verbatim reference) over flat / globe+eye fixtures.
//   2. CHECKER UNIFICATION — vs the retired forced-WebGL2 checker packer, the
//      block differs in EXACTLY one f32 lane: raster_params.w (old literal 8 →
//      0). That lane is dead (raster.ts reads only raster_params.x), and its
//      retirement is the two-packer drift kill this migration exists for.
//      Everything else — including globe_eye, which the old checker never wrote
//      (zero-init) — is byte-identical.
//   3. TILE — writeRasterTileUniform ≡ the retired drawTileF32 slot writer
//      (world-copy shifted and unshifted), and ≡ the checker's z0 tile bytes
//      over the 48 B TileUniforms extent (the old checker allocated 16 floats;
//      lanes 12..15 were dead — past the draper's 48 B pool slot).
//   4. LAYOUT PARITY — uniformBlock(U/Tile) offsets/sizes match
//      reflect(buildRasterModule()).

import { describe, it, expect } from 'vitest'
import { uniformBlock } from '@xgis/engine'
import { reflect } from '@xgis/shader-dsl'
import {
  buildRasterModule,
  rasterU as RASTER_U,
  rasterTileU as RASTER_TILE_U,
  rasterGridN,
  rasterGridVertexCount,
} from '../shaders/dsl/raster'
import {
  writeRasterFrameUniform,
  writeRasterTileUniform,
  type RasterColorParams,
} from './raster-renderer'
import { globeEyeUniform } from './globe-eye-uniform'

const MVP = Float32Array.from({ length: 16 }, (_, i) => (i + 1) * 0.125)
const COLORS: RasterColorParams = {
  opacity: 0.85,
  hueRotate: 12.5,
  brightnessMin: 0.1,
  brightnessMax: 0.9,
  saturation: -0.25,
  contrast: 0.3,
}

interface Fixture {
  readonly name: string
  readonly projType: number
  readonly lon: number
  readonly lat: number
  readonly logDepthFc: number
  readonly eye?: readonly [number, number, number]
  readonly camAnchor: readonly [number, number, number]
}

const FIXTURES: readonly Fixture[] = [
  {
    name: 'flat mercator (projType 0) — 2D centre anchor',
    projType: 0,
    lon: 0,
    lat: 0,
    logDepthFc: 0.111,
    camAnchor: [0.312345, 0.659876, 0],
  },
  {
    name: 'globe (projType 7) with eye — ellipsoid anchor + live globe_eye',
    projType: 7,
    lon: 127.024,
    lat: 37.532,
    logDepthFc: 0.222,
    eye: [12756274.1, 1234567.8, -7654321.9],
    camAnchor: [-3054321.5, 4044321.25, 3867890.75],
  },
]

// DSFUN hi/lo split of the camera anchor — the z18+ jitter fix. hi is
// byte-identical to the pre-split single-f32 lane (fround is idempotent); lo is
// the new low half. Mirrors writeRasterFrameUniform's split exactly.
const hiF = (v: number): number => Math.fround(v)
const loF = (v: number): number => Math.fround(v - Math.fround(v))

/** Reference: the render() slot writer, grown for the DSFUN cam_ecef_center_l low
 *  half (slots: mvp 0, proj 16, raster_params 20, color0 24, color1 28,
 *  cam_ecef_center[hi] 32, cam_ecef_center_l[lo] 36, eye 40). */
function mainReferenceBytes(f: Fixture): Uint8Array {
  const uf = new Float32Array(44)
  uf.set(MVP, 0)
  uf[16] = f.projType
  uf[17] = f.lon
  uf[18] = f.lat
  uf[19] = f.logDepthFc
  const ge = globeEyeUniform(f.eye)
  uf[40] = ge[0]
  uf[41] = ge[1]
  uf[42] = ge[2]
  uf[43] = ge[3]
  uf.set([COLORS.opacity, 0, 0, 0], 20)
  uf.set([COLORS.hueRotate, COLORS.brightnessMin, COLORS.brightnessMax, COLORS.saturation], 24)
  uf.set([COLORS.contrast, 0, 0, 0], 28)
  uf.set([hiF(f.camAnchor[0]), hiF(f.camAnchor[1]), hiF(f.camAnchor[2]), 0], 32)
  uf.set([loF(f.camAnchor[0]), loF(f.camAnchor[1]), loF(f.camAnchor[2]), 0], 36)
  return new Uint8Array(uf.buffer.slice(0))
}

/** Reference: the retired forced-WebGL2 checker packer — literal offsets,
 *  raster_params.w = 8, globe_eye never written (zero-init). Carries the SAME
 *  DSFUN cam_ecef_center_l split the shared packer now writes, so the sole
 *  semantic delta vs packBlock stays the dead raster_params.w lane. */
function checkerReferenceBytes(f: Fixture): Uint8Array {
  const uf = new Float32Array(44)
  uf.set(MVP, 0)
  uf.set([f.projType, f.lon, f.lat, f.logDepthFc], 16)
  uf.set([COLORS.opacity, 0, 0, 8], 20)
  uf.set([COLORS.hueRotate, COLORS.brightnessMin, COLORS.brightnessMax, COLORS.saturation], 24)
  uf.set([COLORS.contrast, 0, 0, 0], 28)
  uf.set([hiF(f.camAnchor[0]), hiF(f.camAnchor[1]), hiF(f.camAnchor[2]), 0], 32)
  uf.set([loF(f.camAnchor[0]), loF(f.camAnchor[1]), loF(f.camAnchor[2]), 0], 36)
  return new Uint8Array(uf.buffer.slice(0))
}

function packBlock(f: Fixture): Uint8Array {
  const block = uniformBlock(RASTER_U)
  writeRasterFrameUniform(
    block,
    { matrix: MVP, logDepthFc: f.logDepthFc, ...(f.eye ? { eye: f.eye } : {}) },
    f.projType,
    f.lon,
    f.lat,
    f.camAnchor,
    COLORS,
  )
  expect(block.byteLength).toBe(176)
  return new Uint8Array(block.buffer)
}

describe('raster global uniform — block bytes ≡ retired render() writer', () => {
  for (const f of FIXTURES) {
    it(f.name, () => {
      expect([...packBlock(f)]).toEqual([...mainReferenceBytes(f)])
    })
  }
})

describe('raster checker unification — sole delta is the dead raster_params.w lane', () => {
  it('flat checker args: bytes identical except f32 lane 23 (8 → 0)', () => {
    const f = FIXTURES[0]!
    const got = packBlock(f)
    const old = checkerReferenceBytes(f)
    const gotF32 = new Float32Array(got.buffer.slice(0))
    const oldF32 = new Float32Array(old.buffer.slice(0))
    for (let lane = 0; lane < 44; lane++) {
      if (lane === 23) continue
      expect(gotF32[lane], `f32 lane ${lane}`).toBe(oldF32[lane])
    }
    expect(oldF32[23]).toBe(8) // the retired literal
    expect(gotF32[23]).toBe(0) // unified — dead lane (shader reads only raster_params.x)
  })
})

describe('raster tile uniform — block bytes ≡ retired drawTileF32 writer', () => {
  const CASES = [
    { name: 'unshifted (wo=0)', west: -11.25, south: 42.5, east: 0, north: 48.75, wo: 0 },
    { name: 'world-copy shifted (wo=1)', west: -11.25, south: 42.5, east: 0, north: 48.75, wo: 1 },
  ] as const
  const ECEF_SW: readonly [number, number, number] = [4187345.1, -832901.7, 4732081.9]
  const MERC_S = 0.83279,
    MERC_DIFF = 0.11814
  // #1040 — the tile's surface grid N now occupies the former `_pad.x` lane
  // (slot 10); `.y` (slot 11) stays reserved (0). A representative globe value —
  // the ladder itself is pinned by the 'raster grid ladder' describe below.
  const GRID_N = 64

  for (const c of CASES) {
    it(c.name, () => {
      // Frozen reference: slots bounds 0, tile_ecef_center 4, merc_y 8, grid 10 (#1040).
      const tf = new Float32Array(12)
      tf[0] = c.west + c.wo * 360
      tf[1] = c.south
      tf[2] = c.east + c.wo * 360
      tf[3] = c.north
      tf[4] = ECEF_SW[0]
      tf[5] = ECEF_SW[1]
      tf[6] = ECEF_SW[2]
      tf[7] = 0
      tf[8] = MERC_S
      tf[9] = MERC_DIFF
      tf[10] = GRID_N
      tf[11] = 0

      const block = uniformBlock(RASTER_TILE_U)
      writeRasterTileUniform(
        block,
        c.west + c.wo * 360,
        c.south,
        c.east + c.wo * 360,
        c.north,
        ECEF_SW,
        MERC_S,
        MERC_DIFF,
        GRID_N,
      )
      expect(block.byteLength).toBe(48)
      expect([...new Uint8Array(block.buffer)]).toEqual([...new Uint8Array(tf.buffer.slice(0))])
    })
  }
})

describe('raster layouts — handle path ≡ reflected module path', () => {
  it('Uniforms + TileUniforms offsets/sizes match reflect(buildRasterModule())', () => {
    const r = reflect(buildRasterModule(false))
    const check = (
      block: { byteLength: number; fieldOffset(n: never): number },
      name: string,
    ): void => {
      const reflected = r.uniforms.find((u) => u.name === name)!
      expect(reflected, name).toBeDefined()
      expect(block.byteLength, name).toBe(reflected.size)
      for (const fl of reflected.fields) {
        expect(block.fieldOffset(fl.name as never), `${name}.${fl.name}`).toBe(fl.offset)
      }
    }
    check(uniformBlock(RASTER_U), 'Uniforms')
    check(uniformBlock(RASTER_TILE_U), 'TileUniforms')
  })
})

// #1040 — the raster surface density ladder. The globe was a coarse ~16-gon at
// z0 because N was a compile-time literal 8 (a z0 whole-world tile and a z18 tile
// drew the same 8×8). N is now per-tile: the globe HALVES per zoom (constant
// per-tile curvature error), floored at 8; flat projections are unchanged at 8.
describe('raster grid ladder (#1040) — globe densifies low zoom, flat stays 8×8', () => {
  it('globe (projType 7) halves per zoom: z0=128 … z4+=8', () => {
    expect(rasterGridN(7, 0)).toBe(128)
    expect(rasterGridN(7, 1)).toBe(64)
    expect(rasterGridN(7, 2)).toBe(32)
    expect(rasterGridN(7, 3)).toBe(16)
    expect(rasterGridN(7, 4)).toBe(8)
    expect(rasterGridN(7, 10)).toBe(8)
    expect(rasterGridN(7, 18)).toBe(8) // floored at 8 — never drops below
  })
  it('flat projections (any non-7 projType) stay 8×8 at every zoom', () => {
    for (const projType of [0, 1, 2, 3, 4, 5, 6]) {
      for (const z of [0, 1, 4, 10, 18]) expect(rasterGridN(projType, z)).toBe(8)
    }
  })
  it('vertex count is N·N·6 (2 tris/cell): z0 globe = 98304, z10/flat = 384', () => {
    expect(rasterGridVertexCount(rasterGridN(7, 0))).toBe(98304) // 128·128·6 — one z0 tile
    expect(rasterGridVertexCount(rasterGridN(7, 10))).toBe(384) // 8·8·6 — z10 globe unchanged
    expect(rasterGridVertexCount(rasterGridN(0, 0))).toBe(384) // flat mercator unchanged
  })
})
