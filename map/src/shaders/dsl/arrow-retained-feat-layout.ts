// ═══ Retained-arrow per-instance feat_data layout — the ONE slot authority ═══
//
// Sibling of icon-retained-feat-layout.ts for the retained ARROW (vector-field glyph)
// primitive (`map.graphics.add({ type: 'arrow' })`). Position slots mirror the SEMANTICS of
// ICON_RETAINED_FEAT / POINT_FEAT's ECEF/abs/Mercator DSFUN block, so the arrow VS reuses the
// point VS's proven geo→clip ladder unchanged.
//
// #825 — the arrow direction is GEOGRAPHIC, not a baked screen angle: the record carries TWO
// geo points, the TAIL (anchor) and a TIP one bearing-step along the outflow direction. The VS
// projects BOTH on the GPU and derives the screen-space direction from their clip-space delta,
// so the arrow stays correctly oriented under camera bearing/pitch/globe (not frozen at add-time).
//
// TINT is NOT here — it lives in a SEPARATE rgba buffer (same as icons) so an
// `updateTriggers.color` recolor re-uploads only the tint attribute.
//
// Layout (f32 slots):
//   TAIL (anchor)
//   0-2    ECEF DSFUN hi (x, y, z)
//   3-5    ECEF DSFUN lo (x, y, z)
//   6      absolute lon (deg)   ·  7  absolute lat (deg)
//   8-11   absolute Mercator DSFUN (x hi, x lo, y hi, y lo)
//   TIP (anchor + one bearing-step along the geographic direction)
//   12-14  ECEF DSFUN hi        · 15-17  ECEF DSFUN lo
//   18     lon (deg)            · 19     lat (deg)
//   20-23  Mercator DSFUN (x hi, x lo, y hi, y lo)
//   24     size (px — arrow LENGTH, pre-DPR design × getSize × DPR)

export const ARROW_RETAINED_FEAT = {
  /** f32 slots per instance in the feat_data storage buffer. */
  stride: 25,
  slot: {
    // tail (anchor)
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
    // tip (direction target)
    tip_ecef_x_h: 12,
    tip_ecef_y_h: 13,
    tip_ecef_z_h: 14,
    tip_ecef_x_l: 15,
    tip_ecef_y_l: 16,
    tip_ecef_z_l: 17,
    tip_abs_lon: 18,
    tip_abs_lat: 19,
    tip_merc_x_h: 20,
    tip_merc_x_l: 21,
    tip_merc_y_h: 22,
    tip_merc_y_l: 23,
    size: 24,
  },
} as const

/** f32 slots per instance in the SEPARATE tint buffer (rgba, 0..1) — same as icons. */
export const ARROW_RETAINED_TINT_STRIDE = 4
