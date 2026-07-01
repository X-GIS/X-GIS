import { buildFormat, type VertexFormat } from '@xgis/compiler'

// ═══ Line vertex-format single source of truth ═══
//
// One declaration of the ECEF-DSFUN line vertex (consumed by the vs_main WGSL
// entry), from which every GPUVertexBufferLayout derives. This layout was
// hand-copied in THREE places in renderer.ts (base + both variant builders) —
// the same copy-paste shape that let the PR-2f polygon variant layout drift;
// deriving all three from this spec removes that risk for lines too.
//
// Position is split hi/lo (DSFUN) for f64-equivalent precision in f32:
// pos_h + pos_l reconstructs the ECEF-RTC residual; the VS adds u.mvp. The
// abs_lon/abs_lat tail feeds the fragment hemisphere-cull recompute. stride 36.
//
// Live writer: the graticule builder (lonLatToEcefDSFUN in graticule.ts) emits
// these 9 floats in field order. NOTE: the tile-line / stroke-outline path
// uses a DIFFERENT entry (vs_line, line.ts) and is NOT covered by this spec;
// the compiler's packDSFUNLineVertices (stride-10) and packECEFLineSegments
// (stride-44, unintegrated) are separate formats left untouched here.
export const LINE_FORMAT: VertexFormat = buildFormat([
  { name: 'pos_h', location: 0, vbFormat: 'float32x3', wgslType: 'vec3<f32>' },
  { name: 'pos_l', location: 1, vbFormat: 'float32x3', wgslType: 'vec3<f32>' },
  { name: 'feature_id', location: 2, vbFormat: 'float32', wgslType: 'f32' },
  { name: 'abs_lon', location: 3, vbFormat: 'float32', wgslType: 'f32' },
  { name: 'abs_lat', location: 4, vbFormat: 'float32', wgslType: 'f32' },
])
