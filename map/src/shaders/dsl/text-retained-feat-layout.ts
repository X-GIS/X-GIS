// ═══ Retained-text per-glyph-instance feat_data layout — the ONE slot authority ═══
//
// Sibling of icon-retained-feat-layout.ts for the retained STATIC TEXT primitive
// (`map.graphics.add({ type: 'text' })`). Unlike icon/circle/arrow (ONE instance per datum), a
// text batch emits ONE instance PER GLYPH: a label's string is shaped once at pack time into N
// glyph quads, and each glyph is a separate instance that shares the label's geo anchor but carries
// its OWN baked screen-space offset + quad size + atlas UV rect. The anchor position slots mirror
// the SEMANTICS of ICON_RETAINED_FEAT / POINT_FEAT's ECEF/abs/Mercator DSFUN block, so the (future)
// text VS reuses the point VS's proven geo→clip ladder unchanged; the glyph is then placed by
// ADDING the per-glyph pixel offset (pen-walk result, baked once) to the projected anchor in screen
// space — exactly the icon quad-offset step, but per-glyph instead of a shared anchor mode.
//
// FILL colour is NOT here — it lives in a SEPARATE rgba tint buffer (same as icons/circles), one
// entry PER GLYPH (all glyphs of a label share the datum's colour), so an `updateTriggers.color`
// recolour re-uploads ONLY the tint attribute.
//
// The offset/size slots are baked in PHYSICAL px (design px × DPR), matching the icon convention,
// so the shader stays a pure px→NDC transform. `page` selects the glyph atlas page a glyph's SDF
// lives on (a label can span pages) — the render side binds/slices per page from it.
//
// Layout (f32 slots):
//   0-2    ECEF DSFUN hi (x, y, z)        ·  3-5  ECEF DSFUN lo (x, y, z)
//   6      absolute lon (deg)             ·  7    absolute lat (deg)
//   8-11   absolute Mercator DSFUN (x hi, x lo, y hi, y lo)
//   12     glyph quad top-left offset x (screen px × DPR, relative to the projected anchor)
//   13     glyph quad top-left offset y (screen px × DPR, y-down — the shader flips to NDC)
//   14     glyph quad width  (px × DPR)   ·  15   glyph quad height (px × DPR)
//   16-19  atlas UV rect (u0, v0, u1, v1) in 0..1
//   20     atlas page index

export const TEXT_RETAINED_FEAT = {
  /** f32 slots per GLYPH instance in the feat_data storage buffer. */
  stride: 21,
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
    off_x: 12,
    off_y: 13,
    size_w: 14,
    size_h: 15,
    u0: 16,
    v0: 17,
    u1: 18,
    v1: 19,
    page: 20,
  },
} as const

/** f32 slots per GLYPH instance in the SEPARATE tint buffer (fill rgba, 0..1) — same as icons. */
export const TEXT_RETAINED_TINT_STRIDE = 4
