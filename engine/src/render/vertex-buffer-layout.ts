import type { VertexFormat } from '@xgis/compiler'

/** Derive a GPUVertexBufferLayout from a single-source vertex-format spec
 *  (@xgis/compiler). The CPU packer that WRITES the bytes and the WGSL
 *  @location attributes that READ them derive from the SAME spec, so a layout
 *  built here cannot drift from either — the class of bug where a hand-copied
 *  layout was bound to a mismatched shader entry is structurally impossible.
 *  Used by every renderer (polygon, point, text, icon). */
export function toVertexBufferLayout(fmt: VertexFormat): GPUVertexBufferLayout {
  return {
    arrayStride: fmt.stride,
    attributes: fmt.fields.map((f) => ({
      shaderLocation: f.location,
      offset: f.offset,
      format: f.vbFormat as GPUVertexFormat,
    })),
  }
}
