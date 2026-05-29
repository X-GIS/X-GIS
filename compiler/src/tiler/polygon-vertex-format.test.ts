import { describe, it, expect } from 'vitest'
import {
  POLYGON_FILL_FORMAT,
  POLYGON_EXTRUDED_FORMAT,
  VB_FORMAT_BYTES,
  field,
} from './polygon-vertex-format'

// The spec is the single source of truth; these tests pin the COMPUTED
// offsets/stride to the values every consumer (packer, WGSL @location, host
// GPUVertexBufferLayout) previously hand-wrote. If the field list changes,
// these update in lockstep — proving the derivation matches the contract.

describe('polygon-vertex-format derivation', () => {
  it('fill format: offsets + stride match the hand-written layout', () => {
    expect(POLYGON_FILL_FORMAT.stride).toBe(24)
    expect(POLYGON_FILL_FORMAT.fields.map((f) => [f.name, f.location, f.offset, f.vbFormat])).toEqual([
      ['q_xy',       0,  0, 'uint16x4'],
      ['q_z',        1,  8, 'uint16x2'],
      ['feature_id', 2, 12, 'float32'],
      ['abs_lon',    3, 16, 'float32'],
      ['abs_lat',    4, 20, 'float32'],
    ])
  })

  it('extruded format: offsets + stride match the hand-written layout', () => {
    expect(POLYGON_EXTRUDED_FORMAT.stride).toBe(44)
    expect(POLYGON_EXTRUDED_FORMAT.fields.map((f) => [f.name, f.location, f.offset, f.vbFormat])).toEqual([
      ['q_xy',        0,  0, 'uint16x4'],
      ['q_z',         1,  8, 'uint16x2'],
      ['feature_id',  2, 12, 'float32'],
      ['abs_lon',     3, 16, 'float32'],
      ['abs_lat',     4, 20, 'float32'],
      ['face_normal', 5, 24, 'float32x3'],
      ['wall_height', 6, 36, 'float32'],
      ['is_top',      7, 40, 'float32'],
    ])
  })

  it('all offsets are 4-byte aligned (WebGPU requires it)', () => {
    for (const fmt of [POLYGON_FILL_FORMAT, POLYGON_EXTRUDED_FORMAT]) {
      for (const f of fmt.fields) expect(f.offset % 4).toBe(0)
      expect(fmt.stride % 4).toBe(0)
    }
  })

  it('locations are contiguous from 0', () => {
    for (const fmt of [POLYGON_FILL_FORMAT, POLYGON_EXTRUDED_FORMAT]) {
      fmt.fields.forEach((f, i) => expect(f.location).toBe(i))
    }
  })

  it('the f32 position tail begins at byte 12 (after uint16×6)', () => {
    // The packer writes u16 lanes 0..5 then f32 from float index 3 (=byte 12).
    expect(field(POLYGON_FILL_FORMAT, 'feature_id').offset).toBe(12)
    expect(VB_FORMAT_BYTES.uint16x4 + VB_FORMAT_BYTES.uint16x2).toBe(12)
  })
})
