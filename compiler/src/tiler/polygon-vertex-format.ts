// ═══ Polygon vertex-format single source of truth ═══
//
// ONE declaration of the quantized-ECEF polygon vertex layout, from which
// every consumer derives — so the format cannot drift across the three
// places it used to be hand-copied:
//
//   1. the COMPILER packer (packECEFPolygonVertices) that WRITES the bytes
//   2. the WGSL @location vertex-input attributes that READ them (DSL)
//   3. the host GPUVertexBufferLayout(s) that BIND them (runtime renderer)
//
// Before this module each of the above was an independent hand-written copy;
// PR-2f's variant-layout bug (a stale float32x3 layout bound to a uint16-
// reading vs_main_ecef) was exactly such a drift. With a single field list,
// offsets/stride are COMPUTED (not retyped) and every consumer reads the same
// numbers.
//
// Layering: this lives in @xgis/compiler (the packer's package). The runtime
// depends on the compiler, so the runtime renderer + shader-DSL can import
// these specs; the compiler must NOT import runtime/WebGPU types, hence
// `vbFormat` / `wgslType` are plain string unions, not GPUVertexFormat /
// ShaderType. The runtime casts `vbFormat` to GPUVertexFormat at the binding
// site and maps `wgslType` to a DSL ShaderType at the entry-param site.

/** WebGPU vertex attribute formats used by the polygon layouts. The byte
 *  size of each is fixed by the WebGPU spec; see VB_FORMAT_BYTES. */
export type VbFormat = 'uint16x4' | 'uint16x2' | 'float32' | 'float32x3'

/** WGSL type a vertex attribute presents to the shader. Note u16 lanes are
 *  widened to u32 by WebGPU, so uint16x4 → vec4<u32>, uint16x2 → vec2<u32>. */
export type WgslType = 'vec4<u32>' | 'vec2<u32>' | 'f32' | 'vec3<f32>'

/** Byte size of each vertex format (WebGPU-defined). */
export const VB_FORMAT_BYTES: Readonly<Record<VbFormat, number>> = {
  uint16x4: 8,
  uint16x2: 4,
  float32: 4,
  float32x3: 12,
}

/** One vertex attribute as authored. `location`, `vbFormat`, `wgslType` are
 *  declared; `offset` is computed (see buildFormat). All offsets are 4-byte
 *  aligned because every VbFormat size is a multiple of 4. */
export interface VertexField {
  readonly name: string
  readonly location: number
  readonly vbFormat: VbFormat
  readonly wgslType: WgslType
}

/** A computed vertex field: the authored attrs plus its byte offset. */
export interface ResolvedField extends VertexField {
  readonly offset: number
  readonly bytes: number
}

/** A fully-resolved vertex format: ordered fields with offsets + total stride. */
export interface VertexFormat {
  readonly fields: readonly ResolvedField[]
  readonly stride: number
}

/** Resolve a field list into offsets + stride by packing tightly in order. */
function buildFormat(fields: readonly VertexField[]): VertexFormat {
  let offset = 0
  const resolved: ResolvedField[] = []
  for (const f of fields) {
    const bytes = VB_FORMAT_BYTES[f.vbFormat]
    resolved.push({ ...f, offset, bytes })
    offset += bytes
  }
  return { fields: resolved, stride: offset }
}

/** Look up a resolved field by name (throws if absent — a programming error). */
export function field(fmt: VertexFormat, name: string): ResolvedField {
  const f = fmt.fields.find((x) => x.name === name)
  if (!f) throw new Error(`polygon-vertex-format: no field '${name}'`)
  return f
}

// ── The polygon fill format (consumed by vs_main_ecef) ───────────────────────
// bytes  0..11  uint16×6 quantized ECEF-RTC position (q_xy @0, q_z @8)
// bytes 12..23  f32 tail: feature_id, abs_lon (deg), abs_lat (deg)
// stride 24.
export const POLYGON_FILL_FORMAT: VertexFormat = buildFormat([
  { name: 'q_xy', location: 0, vbFormat: 'uint16x4', wgslType: 'vec4<u32>' },
  { name: 'q_z', location: 1, vbFormat: 'uint16x2', wgslType: 'vec2<u32>' },
  { name: 'feature_id', location: 2, vbFormat: 'float32', wgslType: 'f32' },
  { name: 'abs_lon', location: 3, vbFormat: 'float32', wgslType: 'f32' },
  { name: 'abs_lat', location: 4, vbFormat: 'float32', wgslType: 'f32' },
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
