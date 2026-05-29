// ═══ Generic vertex-format single-source infrastructure ═══
//
// Domain-agnostic machinery for declaring a vertex buffer layout ONCE as a
// field list and DERIVING every consumer (the CPU packer that writes bytes,
// the WGSL @location attributes that read them, the host GPUVertexBufferLayout
// that binds them). Each render domain (polygon, point, text, icon, line)
// declares its own field list with buildFormat(); see polygon-vertex-format.ts
// for the reference example and the rationale (PR-2f drift bug).
//
// Layering: lives in @xgis/compiler so both the compiler-side packers and the
// runtime renderer/shader-DSL can import it. Formats are plain string unions
// (not GPUVertexFormat / ShaderType) so the compiler stays free of runtime /
// WebGPU types; the runtime casts at the binding site.

/** WebGPU vertex attribute formats used across the renderers. Byte sizes are
 *  fixed by the WebGPU spec; see VB_FORMAT_BYTES. Extend both together. */
export type VbFormat =
  | 'uint16x2' | 'uint16x4'
  | 'uint32'
  | 'float32' | 'float32x2' | 'float32x3' | 'float32x4'

/** WGSL type a vertex attribute presents to the shader. Note u16 lanes are
 *  widened to u32 by WebGPU (uint16x4 → vec4<u32>, uint16x2 → vec2<u32>). */
export type WgslType =
  | 'u32' | 'f32'
  | 'vec2<u32>' | 'vec4<u32>'
  | 'vec2<f32>' | 'vec3<f32>' | 'vec4<f32>'

/** Byte size of each vertex format (WebGPU-defined). */
export const VB_FORMAT_BYTES: Readonly<Record<VbFormat, number>> = {
  uint16x2: 4,
  uint16x4: 8,
  uint32: 4,
  float32: 4,
  float32x2: 8,
  float32x3: 12,
  float32x4: 16,
}

/** One vertex attribute as authored. `offset` is computed (see buildFormat). */
export interface VertexField {
  readonly name: string
  readonly location: number
  readonly vbFormat: VbFormat
  readonly wgslType: WgslType
}

/** A computed vertex field: authored attrs plus its byte offset + size. */
export interface ResolvedField extends VertexField {
  readonly offset: number
  readonly bytes: number
}

/** A fully-resolved vertex format: ordered fields with offsets + total stride. */
export interface VertexFormat {
  readonly fields: readonly ResolvedField[]
  readonly stride: number
}

/** Resolve a field list into offsets + stride by packing tightly in order.
 *  Every VbFormat size is a multiple of 4, so all offsets stay 4-byte aligned. */
export function buildFormat(fields: readonly VertexField[]): VertexFormat {
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
  if (!f) throw new Error(`vertex-format: no field '${name}'`)
  return f
}
