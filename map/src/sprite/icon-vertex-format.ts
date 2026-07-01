import { buildFormat, type VertexFormat } from '@xgis/compiler'

// ═══ Icon sprite vertex-format single source of truth ═══
//
// One declaration of the icon-sprite quad vertex (consumed by the icon
// shader's `vs` entry), from which the GPUVertexBufferLayout (icon-renderer.ts)
// and the per-vertex packer both derive — so they cannot drift. Each icon is a
// screen-space quad: pixel position + atlas UV + per-instance opacity, tint
// rgb, and an sdf flag. stride 36.
export const ICON_FORMAT: VertexFormat = buildFormat([
  { name: 'pos_px', location: 0, vbFormat: 'float32x2', wgslType: 'vec2<f32>' },
  { name: 'uv', location: 1, vbFormat: 'float32x2', wgslType: 'vec2<f32>' },
  { name: 'opacity', location: 2, vbFormat: 'float32', wgslType: 'f32' },
  { name: 'tint', location: 3, vbFormat: 'float32x3', wgslType: 'vec3<f32>' },
  { name: 'sdf', location: 4, vbFormat: 'float32', wgslType: 'f32' },
])
