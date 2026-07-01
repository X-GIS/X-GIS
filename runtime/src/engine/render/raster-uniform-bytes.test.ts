import { describe, expect, it } from 'vitest'
import {
  rasterUniformSlots, rasterUniformBytes, rasterTileSlots, rasterTileBytes,
} from '@xgis/map'

// Byte-identity gate for the raster uniform migrations. raster-renderer hand-coded
// the global 'Uniforms' size (160) + field byte offsets and the per-tile
// 'TileUniforms' size (48) + f32 slots; these are now reflect-derived. Assert
// reflect === the shipped figures, so the migration is provably byte-identical AND
// a future struct field shift fails HERE instead of silently corrupting the raster
// uniform write. (The Uniforms struct already grew once by hand for #600.)
describe('raster global Uniforms — reflect === shipped', () => {
  const S = rasterUniformSlots().slot
  it('bytes === 160 (= slots × 4)', () => {
    expect(rasterUniformBytes()).toBe(160)
    expect(rasterUniformBytes()).toBe(rasterUniformSlots().slots * 4)
  })
  const cases: ReadonlyArray<readonly [string, number]> = [
    ['mvp', 0], ['proj_params', 64], ['raster_params', 80], ['raster_color0', 96],
    ['raster_color1', 112], ['cam_ecef_center', 128], ['globe_eye', 144],
  ]
  for (const [f, b] of cases) it(`${f} @ byte ${b}`, () => { expect(S[f] * 4).toBe(b) })
})

describe('raster per-tile TileUniforms — reflect === shipped', () => {
  const T = rasterTileSlots().slot
  it('bytes === 48 (= slots × 4)', () => {
    expect(rasterTileBytes()).toBe(48)
    expect(rasterTileBytes()).toBe(rasterTileSlots().slots * 4)
  })
  const cases: ReadonlyArray<readonly [string, number]> = [
    ['bounds', 0], ['tile_ecef_center', 16], ['merc_y', 32], ['_pad', 40],
  ]
  for (const [f, b] of cases) it(`${f} @ byte ${b}`, () => { expect(T[f] * 4).toBe(b) })
})
