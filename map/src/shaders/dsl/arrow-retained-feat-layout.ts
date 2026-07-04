// ═══ Retained-arrow per-instance feat_data layout — the ONE slot authority ═══
//
// Sibling of icon-retained-feat-layout.ts for the retained ARROW (vector-field glyph)
// primitive (`map.graphics.add({ type: 'arrow' })`). POSITION slots 0-11 mirror the
// SEMANTICS of ICON_RETAINED_FEAT / POINT_FEAT's ECEF/abs/Mercator DSFUN block, so the
// arrow VS reuses the point VS's proven geo→clip ladder (dsl/point.ts vs_point) unchanged.
// Unlike the icon, an arrow carries NO atlas UV / anchor / separate height — only a single
// LENGTH (size, px) and a screen-space ROTATION; its silhouette is procedural (9 verts).
//
// TINT is NOT here — it lives in a SEPARATE rgba buffer (same as icons) so an
// `updateTriggers.color` recolor re-uploads only the tint attribute.
//
// Layout (f32 slots):
//   0-2    ECEF DSFUN hi (x, y, z)
//   3-5    ECEF DSFUN lo (x, y, z)
//   6      absolute lon (degrees)   — flat-non-Mercator reproject + globe cull
//   7      absolute lat (degrees)
//   8-11   absolute Mercator DSFUN (x hi, x lo, y hi, y lo)
//   12     size (px — arrow LENGTH, pre-DPR design × getSize × DPR)
//   13     rotation (radians, screen-space clockwise — same convention as icon-rotate)

export const ARROW_RETAINED_FEAT = {
  /** f32 slots per instance in the feat_data storage buffer. */
  stride: 14,
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
    size: 12,
    rot_rad: 13,
  },
} as const

/** f32 slots per instance in the SEPARATE tint buffer (rgba, 0..1) — same as icons. */
export const ARROW_RETAINED_TINT_STRIDE = 4
