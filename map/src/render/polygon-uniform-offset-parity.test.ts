import { describe, expect, it } from 'vitest'
import { polygonUniformSlots } from '@xgis/map'

// Byte-identity pins for the polygon 'Uniforms' field offsets that the non-tiled
// MapRenderer (renderer.ts renderToPass) and the GraticuleRenderer packers write
// at. Those were hand-coded byte literals (0/64/80/96/112/128/144/160/176); the
// packers now derive each block's offset from reflect (`S.<field> * 4`). This
// test asserts reflect === the shipped bytes, so:
//   1. the migration is PROVABLY byte-identical (no GPU diff needed), and
//   2. a future struct reorder that shifts one of these fields is caught HERE
//      instead of silently corrupting the non-tiled / graticule uniform write.
// Each block write anchors at its FIRST field; the trailing fields in the block
// (cam_l after cam_h; opacity+log_depth_fc after tile_origin_merc; the u32 pad
// after pick_id; the zoom pad) are contiguous in the struct by construction.
describe('polygon Uniforms — non-tiled / graticule packer field byte offsets', () => {
  const S = polygonUniformSlots().slot
  const cases: ReadonlyArray<readonly [string, number]> = [
    ['mvp', 0],
    ['fill_color', 64],
    ['stroke_color', 80],
    ['proj_params', 96],
    ['cam_h', 112],
    ['tile_origin_merc', 128],
    ['pick_id', 144],
    ['clip_bounds', 160],
    ['zoom', 176],
  ]
  for (const [field, byteOffset] of cases) {
    it(`${field} @ byte ${byteOffset}`, () => {
      expect(S[field] * 4).toBe(byteOffset)
    })
  }
})
