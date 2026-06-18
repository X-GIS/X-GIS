// ═══ Polygon vertex-format single source of truth ═══
//
// ONE declaration of the quantized-ECEF polygon vertex layout, from which
// every consumer derives — so the format cannot drift across the places it
// used to be hand-copied:
//
//   1. the packer that WRITES the bytes
//      - fill: packECEFPolygonVertices (vector-tiler.ts)
//      - extruded: generateWallMeshExtrudedECEF (runtime polygon-mesh.ts)
//   2. the WGSL @location vertex-input attributes that READ them (DSL)
//   3. the host GPUVertexBufferLayout(s) that BIND them (runtime renderer)
//
// Before this each was an independent hand-written copy; PR-2f's variant-
// layout bug (a stale float32x3 layout bound to a uint16-reading vs_main_ecef)
// was exactly such a drift. With a single field list, offsets/stride are
// COMPUTED (not retyped) and every consumer reads the same numbers.
//
// The generic machinery (buildFormat / field / VertexFormat / VbFormat) lives
// in ./vertex-format and is shared with the point/text/icon/line formats.

import { buildFormat, type VertexFormat } from './vertex-format'

export { field, type VbFormat, type WgslType, type VertexField, type ResolvedField, type VertexFormat, VB_FORMAT_BYTES } from './vertex-format'

// ── The polygon fill format (consumed by vs_main_ecef) ───────────────────────
// bytes  0..11  uint16×6 quantized ECEF-RTC position (q_xy @0, q_z @8)
// bytes 12..23  f32 tail: feature_id, abs_lon (local Merc), abs_lat (local Merc)
// bytes 24..27  f32 true_lat (degrees) — the UNCLAMPED latitude the disc
//               (flat_rel) arm projects from, so the ±90 polar caps reach the
//               pole instead of the Merc-clamped 85.05 ring (#398). Additive
//               tail slot; the u16 position + abs_lon/abs_lat slots are
//               unchanged. stride 28.
export const POLYGON_FILL_FORMAT: VertexFormat = buildFormat([
  { name: 'q_xy', location: 0, vbFormat: 'uint16x4', wgslType: 'vec4<u32>' },
  { name: 'q_z', location: 1, vbFormat: 'uint16x2', wgslType: 'vec2<u32>' },
  { name: 'feature_id', location: 2, vbFormat: 'float32', wgslType: 'f32' },
  { name: 'abs_lon', location: 3, vbFormat: 'float32', wgslType: 'f32' },
  { name: 'abs_lat', location: 4, vbFormat: 'float32', wgslType: 'f32' },
  { name: 'true_lat', location: 5, vbFormat: 'float32', wgslType: 'f32' },
])

// ── The polygon extruded format (consumed by vs_main_ecef_extruded) ──────────
// The fill format plus per-vertex extrusion attrs (face_normal lighting,
// wall_height + is_top face discrimination). stride 44.
export const POLYGON_EXTRUDED_FORMAT: VertexFormat = buildFormat([
  { name: 'q_xy', location: 0, vbFormat: 'uint16x4', wgslType: 'vec4<u32>' },
  { name: 'q_z', location: 1, vbFormat: 'uint16x2', wgslType: 'vec2<u32>' },
  { name: 'feature_id', location: 2, vbFormat: 'float32', wgslType: 'f32' },
  { name: 'abs_lon', location: 3, vbFormat: 'float32', wgslType: 'f32' },
  { name: 'abs_lat', location: 4, vbFormat: 'float32', wgslType: 'f32' },
  { name: 'face_normal', location: 5, vbFormat: 'float32x3', wgslType: 'vec3<f32>' },
  { name: 'wall_height', location: 6, vbFormat: 'float32', wgslType: 'f32' },
  { name: 'is_top', location: 7, vbFormat: 'float32', wgslType: 'f32' },
])
