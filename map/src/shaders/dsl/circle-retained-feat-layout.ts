// ═══ Retained-circle per-instance feat_data layout — the ONE slot authority ═══
//
// Sibling of arrow-retained-feat-layout.ts for the retained CIRCLE (disc) primitive
// (`map.graphics.add({ type: 'circle' })`). Position slots mirror the SEMANTICS of
// ARROW_RETAINED_FEAT / POINT_FEAT's ECEF/abs/Mercator DSFUN block, so the circle VS reuses
// the point VS's proven geo→clip ladder unchanged. The style slots (radius, stroke) match
// POINT_FEAT's circle attributes so a retained circle renders through the SAME disc SDF as a
// tile/inline point (pixel-parity by construction).
//
// FILL colour is NOT here — it lives in a SEPARATE rgba tint buffer (same as icons/arrows) so
// an `updateTriggers.color` recolour re-uploads only the tint attribute. STROKE colour + width
// stay in feat (a stroke recolour re-packs the feat buffer — the coarser Phase-1 boundary).
//
// Layout (f32 slots):
//   0-2    ECEF DSFUN hi (x, y, z)
//   3-5    ECEF DSFUN lo (x, y, z)
//   6      absolute lon (deg)   ·  7  absolute lat (deg)
//   8-11   absolute Mercator DSFUN (x hi, x lo, y hi, y lo)
//   12     radius (px, pre-DPR design × getRadius × DPR)
//   13     stroke width (px × DPR)
//   14-17  stroke rgba (0..1)

export const CIRCLE_RETAINED_FEAT = {
  /** f32 slots per instance in the feat_data storage buffer. */
  stride: 18,
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
    radius_px: 12,
    stroke_width_px: 13,
    stroke_r: 14,
    stroke_g: 15,
    stroke_b: 16,
    stroke_a: 17,
  },
} as const

/** f32 slots per instance in the SEPARATE tint buffer (fill rgba, 0..1) — same as icons/arrows. */
export const CIRCLE_RETAINED_TINT_STRIDE = 4
