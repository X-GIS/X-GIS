// ═══ ShowBlock — the per-SHOW uniform struct (#2042 INC-3) ═══
//
// The SHOW class of the Frame/Show/Tile uniform-block split
// (docs/plans/2026-08-24-uniform-block-split.md): every polygonU field whose
// value is a pure function of the rendering show (paint properties,
// re-resolved per frame for zoom/time interpolation) — one slot per show,
// addressed `showIdx × stride` with NO ring: the address is stable for the
// style's lifetime, only the contents refresh per frame.
//
// INC-3 scope: declaration + the exhaustive-partition and byte-parity gates
// (uniform-split-partition.test.ts). NO shader references it and NO writer
// exists yet — zero emission impact, zero runtime change. INC-4 emits the
// variant that reads it, binds it (group 0 binding 10 reserved; 7 is
// TileBlock), and moves the per-show write here.
//
// fill_antialias / fill_extrusion_vertical_gradient are the two Mapbox
// opt-out flags that today ride the SPARE .w lanes of cam_ecef_off_h/l
// (vector-tile-renderer.ts's per-tile write). Those carrier fields RETIRE
// with the split (the offset recombines in-VS, INC-1), so the flags get
// first-class show lanes here — they are per-layer paint properties.

import { uniformStruct, vec4fT, f32T, u32T } from '@xgis/shader-dsl'

export const showBlockU = uniformStruct(
  'ShowBlock',
  { group: 0, binding: 10, as: 'show' },
  {
    fill_color: vec4fT,
    stroke_color: vec4fT,
    opacity: f32T,
    layer_depth_offset: f32T,
    extrude_height_m: f32T,
    extrude_base_m: f32T,
    fill_translate_x: f32T,
    fill_translate_y: f32T,
    pattern_active: u32T,
    light_color_packed: u32T,
    pick_id: u32T,
    fill_antialias: f32T,
    fill_vertical_gradient: f32T,
    _pad0: f32T,
    _pad1: f32T,
    _pad2: f32T,
  },
)
