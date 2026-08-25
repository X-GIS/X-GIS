// ═══ FrameBlock — the per-FRAME uniform struct (#2042 INC-3) ═══
//
// The FRAME class of the Frame/Show/Tile uniform-block split
// (docs/plans/2026-08-24-uniform-block-split.md): every polygonU field with
// ONE value for the whole VTR frame — written once per frame, plain binding
// (no dynamic offset at all).
//
// INC-3 scope: declaration + the exhaustive-partition and byte-parity gates
// (uniform-split-partition.test.ts). NO shader references it and NO writer
// exists yet — zero emission impact. INC-4 binds it (group 0 binding 11
// reserved; 7 = TileBlock, 10 = ShowBlock).
//
// Classification notes (corrections to the plan's original audit, recorded
// there under INC-3):
//   • cam_ecef_center_h/l — the INC-1 absolute camera ECEF anchor (DSFUN
//     hi/lo; _h.w carries the recombine flag). Genuinely frame-class: the
//     per-tile HALF of the RTC offset lives in TileBlock.tile_ecef_center.
//   • input_f32_* / input_color_* — STYLE-GLOBAL user inputs (#1539, one
//     InputStore per style), identical for every show ⇒ frame-class, NOT
//     show-class as the original audit table had them.
//   • cam_h/cam_l are NOT here: they are per-(tile × camera) Mercator DSFUN
//     rels (camMerc − tileOriginMerc, computed per tile by the anchor
//     authority). Deriving them in-shader needs the flat-arm analogue of
//     INC-1 (absolute camera Merc split here + a hi/lo tile origin in
//     TileBlock) — its own increment with its own precision proof.

import { uniformStruct, vec4fT, mat4x4fT, f32T } from '@xgis/shader-dsl'

export const frameBlockU = uniformStruct(
  'FrameBlock',
  { group: 0, binding: 11, as: 'frame' },
  {
    mvp: mat4x4fT,
    proj_params: vec4fT,
    globe_eye: vec4fT,
    light_dir_ecef: vec4fT,
    cam_ecef_center_h: vec4fT,
    cam_ecef_center_l: vec4fT,
    // #2042 INC-6 — absolute camera Mercator (.xy hi, .zw lo; copy-
    // independent): the flat-arm half of the recombination.
    cam_merc_center_hl: vec4fT,
    log_depth_fc: f32T,
    zoom: f32T,
    _pad0: f32T,
    _pad1: f32T,
    input_f32_0: f32T,
    input_f32_1: f32T,
    input_f32_2: f32T,
    input_f32_3: f32T,
    input_f32_4: f32T,
    input_f32_5: f32T,
    input_f32_6: f32T,
    input_f32_7: f32T,
    input_color_0: vec4fT,
    input_color_1: vec4fT,
    input_color_2: vec4fT,
    input_color_3: vec4fT,
  },
)
