import { buildFormat, type VertexFormat } from '@xgis/compiler'

// ═══ Point vertex-format single source of truth ═══
//
// One declaration of the point-marker quad vertex layout (consumed by the
// vs_point WGSL entry), from which the GPUVertexBufferLayout (point-renderer.ts)
// and the per-vertex packer (PointRenderer.setDraws) both derive — so they
// cannot drift. Point markers are a screen-space quad: a per-instance center
// (lon/lat, expanded in the VS), a quad corner id, and the picking feature id.
// stride 16.
export const POINT_FORMAT: VertexFormat = buildFormat([
  { name: 'center', location: 0, vbFormat: 'float32x2', wgslType: 'vec2<f32>' }, // lon/lat
  { name: 'quad_id', location: 1, vbFormat: 'uint32', wgslType: 'u32' },         // corner 0..3
  { name: 'feat_id', location: 2, vbFormat: 'float32', wgslType: 'f32' },        // picking key
])
