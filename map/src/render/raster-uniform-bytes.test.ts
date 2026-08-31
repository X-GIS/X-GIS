import { describe, expect, it } from 'vitest'
import { rasterUniformSlots, rasterUniformBytes, rasterTileSlots, rasterTileBytes } from '@xgis/map'

// Byte-identity gate for the raster uniform migrations. raster-renderer hand-coded
// the global 'Uniforms' size + field byte offsets and the per-tile
// 'TileUniforms' size (48) + f32 slots; these are now reflect-derived. Assert
// reflect === the shipped figures, so the migration is provably byte-identical AND
// a future struct field shift fails HERE instead of silently corrupting the raster
// uniform write. (The Uniforms struct grew by hand for #600 globe_eye, then again
// for the DSFUN cam_ecef_center_l low half — the z18+ raster-jitter fix — 160→176.)
describe('raster global Uniforms — reflect === shipped', () => {
  const S = rasterUniformSlots().slot
  it('bytes === 176 (= slots × 4)', () => {
    expect(rasterUniformBytes()).toBe(176)
    expect(rasterUniformBytes()).toBe(rasterUniformSlots().slots * 4)
  })
  const cases: ReadonlyArray<readonly [string, number]> = [
    ['mvp', 0],
    ['proj_params', 64],
    ['raster_params', 80],
    ['raster_color0', 96],
    ['raster_color1', 112],
    ['cam_ecef_center', 128],
    // DSFUN low half, inserted adjacent to its high partner (mirrors polygon's
    // cam_ecef_off_h/l pairing); globe_eye shifts 144 → 160.
    ['cam_ecef_center_l', 144],
    ['globe_eye', 160],
  ]
  for (const [f, b] of cases)
    it(`${f} @ byte ${b}`, () => {
      expect(S[f] * 4).toBe(b)
    })
})

describe('raster per-tile TileUniforms — reflect === shipped', () => {
  const T = rasterTileSlots().slot
  it('bytes === 336 (= slots × 4)', () => {
    // 48 → 336 (#2137): the CPU trig table added row_trig + col_trig, two
    // `array<vec4<f32>, 9>` = 2 × 144 B. The VS used to build the ~6.4e6 m ECEF
    // from angles, so every transcendental it evaluated multiplied the Earth
    // radius (1.17e+3 m of ground displacement measured on SwiftShader); the
    // table removes them from that path. This pin is the reflect-derived size —
    // it moves only when the struct does, which is the point.
    expect(rasterTileBytes()).toBe(336)
    expect(rasterTileBytes()).toBe(rasterTileSlots().slots * 4)
  })
  const cases: ReadonlyArray<readonly [string, number]> = [
    ['bounds', 0],
    ['tile_ecef_center', 16],
    ['merc_y', 32],
    // #1040 — the trailing vec2 was renamed `_pad` → `grid` (x = surface grid N,
    // fed by rasterGridN; y reserved). Byte offset/layout unchanged (vec2 @ 40).
    ['grid', 40],
  ]
  for (const [f, b] of cases)
    it(`${f} @ byte ${b}`, () => {
      expect(T[f] * 4).toBe(b)
    })
})
