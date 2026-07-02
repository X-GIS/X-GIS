import { describe, it, expect } from 'vitest'
import { POINT_FEAT, POINT_FEAT_STYLE_SLOTS } from './point-feat-layout'
import { POINT_FEAT_STRIDE } from '../../render/point-feature-packer'

// ═══ #740 R8 — the ONE point feat_data layout authority ═══
//
// The spec is shared by the CPU packer and the point shader; these
// invariants are what both sides rely on. Emitted WGSL is unchanged by
// construction (slot numbers are identical — the polygon-variant golden
// gate would catch any drift), so the test pins the SPEC, not the emit.

describe('POINT_FEAT layout spec', () => {
  it('slots are a bijection onto [0, stride)', () => {
    const values = Object.values(POINT_FEAT.slot)
    expect(values.length).toBe(POINT_FEAT.stride)
    expect(new Set(values).size).toBe(values.length)
    expect(Math.min(...values)).toBe(0)
    expect(Math.max(...values)).toBe(POINT_FEAT.stride - 1)
  })

  it('style block [0, POINT_FEAT_STYLE_SLOTS) is exactly the Pass-0 verbatim-copy slots', () => {
    const style = [
      POINT_FEAT.slot.radius_px,
      POINT_FEAT.slot.fill_r, POINT_FEAT.slot.fill_g, POINT_FEAT.slot.fill_b, POINT_FEAT.slot.fill_a,
      POINT_FEAT.slot.stroke_r, POINT_FEAT.slot.stroke_g, POINT_FEAT.slot.stroke_b, POINT_FEAT.slot.stroke_a,
      POINT_FEAT.slot.stroke_width_px,
      POINT_FEAT.slot.flags_packed,
    ]
    expect(style.length).toBe(POINT_FEAT_STYLE_SLOTS)
    expect([...style].sort((a, b) => a - b)).toEqual(style)
    expect(style[style.length - 1]).toBe(POINT_FEAT_STYLE_SLOTS - 1)
  })

  it('position slots sit above the style block (packer Pass-1 overwrite region)', () => {
    const position = [
      POINT_FEAT.slot.ecef_x_h, POINT_FEAT.slot.ecef_y_h, POINT_FEAT.slot.ecef_z_h,
      POINT_FEAT.slot.ecef_x_l, POINT_FEAT.slot.ecef_y_l, POINT_FEAT.slot.ecef_z_l,
      POINT_FEAT.slot.abs_lon, POINT_FEAT.slot.abs_lat,
      POINT_FEAT.slot.merc_x_h, POINT_FEAT.slot.merc_x_l,
      POINT_FEAT.slot.merc_y_h, POINT_FEAT.slot.merc_y_l,
    ]
    for (const s of position) expect(s).toBeGreaterThanOrEqual(POINT_FEAT_STYLE_SLOTS)
  })

  it('packer POINT_FEAT_STRIDE re-export matches the spec', () => {
    expect(POINT_FEAT_STRIDE).toBe(POINT_FEAT.stride)
  })

  it('pins the frozen slot map (a change here means shader + packer must re-bake together)', () => {
    expect(POINT_FEAT).toEqual({
      stride: 24,
      slot: {
        radius_px: 0,
        fill_r: 1, fill_g: 2, fill_b: 3, fill_a: 4,
        stroke_r: 5, stroke_g: 6, stroke_b: 7, stroke_a: 8,
        stroke_width_px: 9,
        flags_packed: 10,
        ecef_x_h: 11, ecef_y_h: 12, ecef_z_h: 13,
        ecef_x_l: 14, ecef_y_l: 15, ecef_z_l: 16,
        abs_lon: 17, abs_lat: 18,
        shape_id: 19,
        merc_x_h: 20, merc_x_l: 21, merc_y_h: 22, merc_y_l: 23,
      },
    })
  })
})
