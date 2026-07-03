// Vertex attribute-layout consistency: every polygon/line GPUVertexBufferLayout
// + its CPU packer now DERIVE from a single-source vertex-format spec
// (POLYGON_FILL_FORMAT / POLYGON_EXTRUDED_FORMAT in @xgis/compiler, LINE_FORMAT
// in render/line-vertex-format.ts) via toVertexBufferLayout(). So instead of
// re-parsing renderer.ts literals (which no longer exist), this gate (1) pins
// each spec to its canonical shape and (2) cross-checks the spec against the
// WGSL @location types the shader actually reads — closing the layout↔shader
// drift that the PR-2f variant bug exploited.
//
// The tile-line / stroke-outline path (vs_line, line.ts) and the compiler's
// packDSFUNLineVertices (stride-10) / packECEFLineSegments (stride-44,
// unintegrated) are SEPARATE line formats not covered here.

import { describe, it, expect } from 'vitest'
import { emitPolygonWgsl } from '@xgis/map'
import { POLYGON_FILL_FORMAT, POLYGON_EXTRUDED_FORMAT } from '@xgis/compiler'
import { LINE_FORMAT } from '@xgis/map'
import { specShaderMismatches } from '@xgis/map'

const SHADER_SRC = emitPolygonWgsl(null, false)

describe('vertex attribute-layout consistency (spec ↔ WGSL @location)', () => {
  it('polygon fill spec is PR 2f quantized ECEF + true_lat (stride 28: uint16x4 + uint16x2 + 4×f32)', () => {
    expect(POLYGON_FILL_FORMAT.stride).toBe(28)
    expect(POLYGON_FILL_FORMAT.fields.map((f) => [f.location, f.offset, f.vbFormat])).toEqual([
      [0, 0, 'uint16x4'],
      [1, 8, 'uint16x2'],
      [2, 12, 'float32'],
      [3, 16, 'float32'],
      [4, 20, 'float32'],
      [5, 24, 'float32'],
    ])
    for (const f of POLYGON_FILL_FORMAT.fields) expect(f.offset % 4).toBe(0)
  })

  it('polygon extruded spec is PR 2f quantized ECEF (stride 44)', () => {
    expect(POLYGON_EXTRUDED_FORMAT.stride).toBe(44)
    expect(POLYGON_EXTRUDED_FORMAT.fields.map((f) => [f.location, f.offset, f.vbFormat])).toEqual([
      [0, 0, 'uint16x4'],
      [1, 8, 'uint16x2'],
      [2, 12, 'float32'],
      [3, 16, 'float32'],
      [4, 20, 'float32'],
      [5, 24, 'float32x3'],
      [6, 36, 'float32'],
      [7, 40, 'float32'],
    ])
    for (const f of POLYGON_EXTRUDED_FORMAT.fields) expect(f.offset % 4).toBe(0)
  })

  it('line spec is ECEF-DSFUN (stride 36: pos_h f32x3 + pos_l f32x3 + 3×f32)', () => {
    expect(LINE_FORMAT.stride).toBe(36)
    expect(LINE_FORMAT.fields.map((f) => [f.location, f.offset, f.vbFormat])).toEqual([
      [0, 0, 'float32x3'],
      [1, 12, 'float32x3'],
      [2, 24, 'float32'],
      [3, 28, 'float32'],
      [4, 32, 'float32'],
    ])
    for (const f of LINE_FORMAT.fields) expect(f.offset % 4).toBe(0)
  })

  it('polygon fill spec ↔ vs_main_ecef WGSL @location types match exactly', () => {
    expect(specShaderMismatches(POLYGON_FILL_FORMAT, SHADER_SRC, 'vs_main_ecef')).toEqual([])
  })

  it('polygon extruded spec ↔ vs_main_ecef_extruded WGSL @location types match exactly', () => {
    expect(
      specShaderMismatches(POLYGON_EXTRUDED_FORMAT, SHADER_SRC, 'vs_main_ecef_extruded'),
    ).toEqual([])
  })

  it('line spec ↔ vs_main WGSL @location types match exactly', () => {
    expect(specShaderMismatches(LINE_FORMAT, SHADER_SRC, 'vs_main')).toEqual([])
  })
})
