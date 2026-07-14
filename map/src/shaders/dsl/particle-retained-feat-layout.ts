// ═══ Retained-particle-flow per-instance feat_data layout — the ONE slot authority ═══
//
// Sibling of arrow-retained-feat-layout.ts / circle-retained-feat-layout.ts for the retained
// PARTICLE-FLOW primitive (`map.graphics.add({ type: 'particle-flow' })`, #826). Each instance is
// ONE particle drifting along its home-gu outflow direction — the wind-map aesthetic as a second
// reading of the SAME per-gu field the static arrow draws (design §1.3).
//
// Candidate (b), VS-integrated STATELESS drift (design §3.2): the particle position at time `t`
// is a CLOSED-FORM function of a static per-instance seed + the per-frame animation clock — no
// state buffers, no ping-pong. So this layout carries, per particle:
//
//   ORIGIN (the seed anchor — a jittered point in the home gu) as the SAME 12-slot ECEF/abs/
//   Mercator DSFUN block the point/icon/arrow/circle packers write, so the shader reuses the
//   proven geo→clip ladder unchanged; and
//   DIRECTION TIP (origin + one bearing-step along the gu outflow direction) as a SECOND 12-slot
//   block — the arrow's #825 two-point trick, so the drift direction is GEOGRAPHIC (correct under
//   any camera bearing / pitch / globe), projected on the GPU, not a baked screen angle.
//
// The drift math is closed-form in the VS: phase = fract(t / lifetime + phase_norm); the particle
// drifts `phase · drift_px` screen-px along the projected direction, fades in at birth / out at
// death, and — because phase is `fract` — respawns at the origin on the loop (design §3.2). DENSITY
// ∝ volume is a PACK-TIME allocation (more particles seeded in a busier gu, retained-particle-
// packer.ts), NOT a shader input — the shader never sees the volume.
//
// TINT (rgba) is NOT here — it lives in a SEPARATE buffer (same as icons/arrows/circles) so an
// `updateTriggers.color` recolour re-uploads only the tint attribute.
//
// Layout (f32 slots):
//   ORIGIN (seed anchor)
//   0-2    ECEF DSFUN hi (x, y, z)          ·  3-5  ECEF DSFUN lo (x, y, z)
//   6      absolute lon (deg)               ·  7    absolute lat (deg)
//   8-11   absolute Mercator DSFUN (x hi, x lo, y hi, y lo)
//   DIRECTION TIP (origin + one bearing-step along the gu outflow direction)
//   12-14  ECEF DSFUN hi                    · 15-17  ECEF DSFUN lo
//   18     lon (deg)                        · 19     lat (deg)
//   20-23  Mercator DSFUN (x hi, x lo, y hi, y lo)
//   PARTICLE
//   24     radius (px × DPR — the disc size)
//   25     drift length (px × DPR — how far the particle travels over ONE lifetime)
//   26     lifetime (seconds — the drift-and-respawn period)
//   27     phase offset (0..1 — the per-particle birth-time offset that de-syncs the field)

export const PARTICLE_RETAINED_FEAT = {
  /** f32 slots per instance in the feat_data storage buffer. */
  stride: 28,
  slot: {
    // origin (seed anchor)
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
    // direction tip (origin + one bearing-step along the gu outflow direction)
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
    // particle
    radius_px: 24,
    drift_px: 25,
    lifetime_s: 26,
    phase_norm: 27,
  },
} as const

/** f32 slots per instance in the SEPARATE tint buffer (rgba, 0..1) — same as icons/arrows/circles. */
export const PARTICLE_RETAINED_TINT_STRIDE = 4
