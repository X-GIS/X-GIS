// ═══ Retained-icon per-instance feat_data layout — the ONE slot authority (#797 P1) ═══
//
// The packed-f32 record shared by the CPU packer (graphics/retained-icon-packer.ts)
// and the retained-icon shader (dsl/icon-retained.ts) for the host DRAWING API's
// geo-anchored retained icon batch. Same discipline as point-feat-layout.ts: every
// slot has exactly ONE definition, so the shader's `featData.at(inst*STRIDE + F.x)`
// and the packer's `feat[base + F.x]` read the same named constant and cannot drift.
//
// POSITION slots (0-11) mirror the SEMANTICS of POINT_FEAT's ECEF/abs/Mercator
// DSFUN block so the retained-icon VS can reuse the point VS's proven geo→clip
// ladder (dsl/point.ts vs_point) unchanged. The remaining slots carry the icon's
// screen-space quad geometry (rectangular w/h, atlas UV rect, rotation, anchor).
//
// TINT is deliberately NOT in this record — it lives in a SEPARATE contiguous
// rgba buffer so an `updateTriggers.color` recolor re-uploads ONLY the tint
// attribute in one writeBuffer (the #797 P1 gate). getSize / getPosition / getImage
// re-uploads rewrite THIS (feat) buffer wholesale — a documented Phase-1 boundary.
//
// Layout (f32 slots):
//   0-2    ECEF DSFUN hi (x, y, z)   — copy-independent absolute ECEF, hi/lo split
//   3-5    ECEF DSFUN lo (x, y, z)
//   6      absolute lon (degrees)    — flat-non-Mercator reproject + globe cull
//   7      absolute lat (degrees)
//   8-11   absolute Mercator DSFUN (x hi, x lo, y hi, y lo) — precise flat-Merc pos
//   12     size_w (px, pre-DPR-scaled design width  × icon-size)
//   13     size_h (px)
//   14-17  atlas UV rect (u0, v0, u1, v1) in [0,1] texture space
//   18     rotation (radians, screen-space clockwise — icon-rotate)
//   19     anchor mode (0 center · 1 top · 2 bottom · 3 left · 4 right ·
//                       5 top-left · 6 top-right · 7 bottom-left · 8 bottom-right)

export const ICON_RETAINED_FEAT = {
  /** f32 slots per instance in the feat_data storage buffer. */
  stride: 20,
  slot: {
    ecef_x_h: 0,
    ecef_y_h: 1,
    ecef_z_h: 2,
    ecef_x_l: 3,
    ecef_y_l: 4,
    ecef_z_l: 5,
    abs_lon: 6,
    abs_lat: 7,
    merc_x_h: 8,
    merc_x_l: 9,
    merc_y_h: 10,
    merc_y_l: 11,
    size_w: 12,
    size_h: 13,
    u0: 14,
    v0: 15,
    u1: 16,
    v1: 17,
    rot_rad: 18,
    anchor_mode: 19,
  },
} as const

/** f32 slots per instance in the SEPARATE tint buffer (rgba, 0..1). */
export const ICON_RETAINED_TINT_STRIDE = 4
