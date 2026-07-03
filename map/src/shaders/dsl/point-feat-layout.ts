// ═══ Point per-feature feat_data layout — the ONE slot authority (#740 R8) ═══
//
// The stride-24 packed-f32 record shared by the CPU packer
// (render/point-feature-packer.ts) and the point shader (dsl/point.ts). Both
// sides used to hard-code these slot indices independently, kept in sync by
// COMMENTS — the storage twin of the `uf[slot+lane]` uniform disease #733
// retired with UniformBlock. Every slot now has exactly one definition; the
// shader's `featData.at(fid*STRIDE + F.abs_lon)` and the packer's
// `feat[dstOff + F.abs_lon]` read the same named constant, so the layouts
// cannot drift and a slot change reflows both sides mechanically.
//
// Layout (f32 slots):
//   0      radius_px
//   1-4    fill rgba
//   5-8    stroke rgba
//   9      stroke width (px)
//   10     packed flags (size mode / anchor / billboard bits — shader unpacks)
//   11-13  ECEF DSFUN hi (x, y, z)
//   14-16  ECEF DSFUN lo (x, y, z)
//   17-18  absolute lon / lat (degrees)
//   19     shape_id (SDF shape registry)
//   20-23  absolute Mercator DSFUN (x hi, x lo, y hi, y lo)

export const POINT_FEAT = {
  /** f32 slots per feature. */
  stride: 24,
  slot: {
    radius_px: 0,
    fill_r: 1,
    fill_g: 2,
    fill_b: 3,
    fill_a: 4,
    stroke_r: 5,
    stroke_g: 6,
    stroke_b: 7,
    stroke_a: 8,
    stroke_width_px: 9,
    flags_packed: 10,
    ecef_x_h: 11,
    ecef_y_h: 12,
    ecef_z_h: 13,
    ecef_x_l: 14,
    ecef_y_l: 15,
    ecef_z_l: 16,
    abs_lon: 17,
    abs_lat: 18,
    shape_id: 19,
    merc_x_h: 20,
    merc_x_l: 21,
    merc_y_h: 22,
    merc_y_l: 23,
  },
} as const

/** Style slots copied verbatim per world copy (Pass 0 of the packer):
 *  radius + fill + stroke + width + flags = slots [0, 11). */
export const POINT_FEAT_STYLE_SLOTS = 11
