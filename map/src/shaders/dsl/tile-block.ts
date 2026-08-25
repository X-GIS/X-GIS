// ═══ TileBlock — the per-tile-STATIC uniform struct (#2042 INC-2) ═══
//
// The TILE class of the Frame/Show/Tile uniform-block split
// (docs/plans/2026-08-24-uniform-block-split.md): every polygonU field whose
// value is a pure function of (source-layer slice, tile, worldCopy,
// clipTarget) — written ONCE when the slot is allocated, never per frame.
//
// INC-2 scope: this declaration is the SINGLE AUTHORITY for the CPU-side
// packer (`uniformBlock(tileBlockU)` in render/tile-uniform-arena.ts) and
// for the field-parity gate against polygonU; NO shader references it yet,
// so it emits nothing and changes no pipeline. INC-4 binds it for real —
// the group/binding below are that increment's reservation: binding 7 is
// the first group-0 slot unused by ANY dsl module today (0-6, 8, 9 are
// taken across polygon/line/sdf/label). tile-uniform-arena-parity.test.ts
// is what guarantees the bytes staged since INC-2 are exactly the bytes
// the INC-4 shader will read.
//
// Field-by-field provenance (all copied from polygonU, same semantics):
//   tile_origin_merc_hl — worldOff-shifted tile origin (Mercator m, hi/lo);
//                        PER COPY.
//   tile_extent_m      — tile extent (Mercator m at the equator).
//   tile_dequant_scale — quantised-vertex dequant scale.
//   tile_dequant_half  — quantised-vertex dequant half-range.
//   clip_bounds        — absolute-Mercator clip mask, or the −1e30 "no clip"
//                        sentinel; PER CLIP TARGET (fallback draws clip to the
//                        visible descendant, the Korea fill-drop precedent).
//   tile_ecef_center_h/l — the tile's ABSOLUTE ellipsoid-ECEF anchor, DSFUN
//                        hi/lo (INC-1); worldCopy-INDEPENDENT.
//
// (`_pad0` keeps the three dequant scalars + extent on one 16-byte row —
//  reflect-derived like every layout in this repo, never a literal offset.)

import { uniformStruct, vec4fT, f32T } from '@xgis/shader-dsl'

export const tileBlockU = uniformStruct(
  'TileBlock',
  { group: 0, binding: 7, as: 'tile' },
  {
    // #2042 INC-6 — the worldOff-shifted tile origin as a DSFUN hi/lo pair
    // (.xy hi, .zw lo): the split's flat-arm recombination needs the low
    // bits the legacy single-f32 tile_origin_merc lane lacks. The legacy
    // lane retires with the rebind; this pair (its .xy IS that value) is
    // the TileBlock representation from day one.
    tile_origin_merc_hl: vec4fT,
    tile_extent_m: f32T,
    tile_dequant_scale: f32T,
    tile_dequant_half: f32T,
    _pad0: f32T,
    clip_bounds: vec4fT,
    tile_ecef_center_h: vec4fT,
    tile_ecef_center_l: vec4fT,
  },
)
