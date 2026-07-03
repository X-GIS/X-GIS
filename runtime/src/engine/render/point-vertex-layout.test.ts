import { describe, it, expect } from 'vitest'
import { emitPointWgsl } from '@xgis/map'
import { POINT_FORMAT } from '@xgis/map'
import { specShaderMismatches } from '@xgis/map'

// Single-source guard for the point vertex format. POINT_FORMAT drives the
// GPUVertexBufferLayout (point-renderer.ts) and the packer's float slots; this
// test pins the spec to its canonical shape and cross-checks it against the
// vs_point @location types the shader actually declares — closing the
// layout↔shader drift that point markers previously had NO test for.

const SHADER_SRC = emitPointWgsl()

describe('point vertex-format single-source consistency', () => {
  it('spec shape: stride 16 (center f32x2 + quad_id u32 + feat_id f32)', () => {
    expect(POINT_FORMAT.stride).toBe(16)
    expect(POINT_FORMAT.fields.map((f) => [f.location, f.offset, f.vbFormat])).toEqual([
      [0, 0, 'float32x2'],
      [1, 8, 'uint32'],
      [2, 12, 'float32'],
    ])
  })

  it('spec ↔ vs_point WGSL @location types match exactly', () => {
    expect(specShaderMismatches(POINT_FORMAT, SHADER_SRC, 'vs_point')).toEqual([])
  })
})
