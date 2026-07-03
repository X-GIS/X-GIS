// ═══ Polygon 'Uniforms' — UniformBlock ≡ slot-writer equivalence (#733 P2c) ═══
//
// The polygon struct is the hardest block target in the repo: 27 flat fields,
// mixed kinds (u32 pick_id / light_color_packed between f32 scalars), vec2
// pairs sharing 16-byte rows, and scalar rows packed 4-to-a-row. This gate
// proves the block's per-field writes are byte-identical to the retired
// slot-arithmetic style over ALL of it:
//   · a frozen slot-writer reference (polygonUniformSlots(), the source VTR
//     still uses) with non-trivial values in every lane,
//   · u32 raw-word survival for pick_id (0xABCD1234 — an f32-routed store
//     would corrupt the word),
//   · per-field offset parity + byteLength/stride vs the reflect() path.
// renderer.ts (non-tiled) and graticule-renderer write through this block; the
// existing fill-color / fill-extrusion / pattern-uv wiring tests pin their
// real staged bytes on top of this.

import { describe, it, expect } from 'vitest'
import { uniformBlock } from '@xgis/engine'
import { polygonU as POLYGON_U } from '../shaders/dsl/polygon'
import {
  polygonUniformSlots,
  polygonUniformBytes,
  polygonUniformStride,
} from './polygon-uniform-slots'

const MVP = Float32Array.from({ length: 16 }, (_, i) => (i + 1) * 0.0625)

describe('polygon Uniforms — block ≡ slot writer', () => {
  it('27-field full pack is byte-identical (incl. u32 pick_id raw word)', () => {
    // ── Frozen reference: the retired slot-arithmetic style ──
    const S = polygonUniformSlots().slot
    const ref = new ArrayBuffer(polygonUniformBytes())
    new Float32Array(ref, S.mvp * 4, 16).set(MVP)
    new Float32Array(ref, S.fill_color * 4, 4).set([0.1, 0.2, 0.3, 0.4])
    new Float32Array(ref, S.stroke_color * 4, 4).set([0.5, 0.6, 0.7, 0.8])
    new Float32Array(ref, S.proj_params * 4, 4).set([7, 127.024, 37.532, 0])
    new Float32Array(ref, S.cam_h * 4, 4).set([1.25, -2.5, 0.0003, -0.0007]) // cam_h.xy, cam_l.xy
    new Float32Array(ref, S.tile_origin_merc * 4, 4).set([12345.5, -6789.25, 0.85, 0.123]) // + opacity, log_depth_fc
    new Uint32Array(ref, S.pick_id * 4, 1).set([0xabcd1234])
    new Float32Array(ref, S.layer_depth_offset * 4, 3).set([3, 4096.5, 55.75]) // + tile_extent_m, extrude_height_m
    new Float32Array(ref, S.clip_bounds * 4, 4).set([-1e30, 1, 2, 3])
    new Float32Array(ref, S.zoom * 4, 4).set([14.5, 5.25, 0.01, -0.02]) // + extrude_base_m, fill_translate_x/y
    new Float32Array(ref, S.tile_dequant_scale * 4, 2).set([0.00012, 8192])
    new Uint32Array(ref, S.light_color_packed * 4, 2).set([0xffeeddcc, 0])
    new Float32Array(ref, S.cam_ecef_off_h * 4, 4).set([111.5, -222.25, 333.125, 0])
    new Float32Array(ref, S.cam_ecef_off_l * 4, 4).set([0.015, -0.025, 0.035, 0])
    new Float32Array(ref, S.light_dir_ecef * 4, 4).set([0.288, -0.498, 0.996, 1.5])
    new Float32Array(ref, S.globe_eye * 4, 4).set([0.5, -0.5, 0.7071, 0.31])

    // ── The block pack, same values field-by-field ──
    const block = uniformBlock(POLYGON_U)
    block.write({
      mvp: MVP,
      fill_color: [0.1, 0.2, 0.3, 0.4],
      stroke_color: [0.5, 0.6, 0.7, 0.8],
      proj_params: [7, 127.024, 37.532, 0],
      cam_h: [1.25, -2.5],
      cam_l: [0.0003, -0.0007],
      tile_origin_merc: [12345.5, -6789.25],
      opacity: 0.85,
      log_depth_fc: 0.123,
      pick_id: 0xabcd1234,
      layer_depth_offset: 3,
      tile_extent_m: 4096.5,
      extrude_height_m: 55.75,
      clip_bounds: [-1e30, 1, 2, 3],
      zoom: 14.5,
      extrude_base_m: 5.25,
      fill_translate_x: 0.01,
      fill_translate_y: -0.02,
      tile_dequant_scale: 0.00012,
      tile_dequant_half: 8192,
      light_color_packed: 0xffeeddcc,
      _pad_light_align: 0,
      cam_ecef_off_h: [111.5, -222.25, 333.125, 0],
      cam_ecef_off_l: [0.015, -0.025, 0.035, 0],
      light_dir_ecef: [0.288, -0.498, 0.996, 1.5],
      globe_eye: [0.5, -0.5, 0.7071, 0.31],
    })

    expect(block.byteLength).toBe(polygonUniformBytes())
    expect([...new Uint8Array(block.buffer)]).toEqual([...new Uint8Array(ref)])
    // u32 raw words survived (f32 routing would corrupt both)
    const u32 = new Uint32Array(block.buffer)
    expect(u32[S.pick_id]).toBe(0xabcd1234)
    expect(u32[S.light_color_packed]).toBe(0xffeeddcc)
  })

  it('per-field offsets + size + ring stride match the reflect() path', () => {
    const block = uniformBlock(POLYGON_U)
    const u = polygonUniformSlots()
    for (const [name, slot] of Object.entries(u.slot)) {
      expect(block.fieldOffset(name as never), name).toBe(slot * 4)
    }
    expect(block.byteLength).toBe(polygonUniformBytes())
    expect(block.std140Stride()).toBe(polygonUniformStride())
  })
})
