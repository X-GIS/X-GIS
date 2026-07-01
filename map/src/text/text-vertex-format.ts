import { buildFormat, type VertexFormat } from '@xgis/compiler'

// ═══ Text glyph vertex-format single source of truth ═══
//
// One declaration of the SDF text-glyph quad vertex (consumed by the text
// shader's `vs` entry), from which the GPUVertexBufferLayout (text-renderer.ts)
// and the per-vertex glyph packer both derive — so they cannot drift. Each
// glyph is a screen-space quad: pixel position + atlas UV. stride 16.
export const TEXT_FORMAT: VertexFormat = buildFormat([
  { name: 'pos_px', location: 0, vbFormat: 'float32x2', wgslType: 'vec2<f32>' },
  { name: 'uv', location: 1, vbFormat: 'float32x2', wgslType: 'vec2<f32>' },
])
