import { describe, it, expect } from 'vitest'
import { emitIconWgsl } from '@xgis/map'
import { ICON_FORMAT } from '@xgis/map'
import { specShaderMismatches } from '@xgis/map'

// Single-source guard for the icon sprite vertex format. ICON_FORMAT drives the
// GPUVertexBufferLayout (icon-renderer.ts) and the packer's float slots; this
// cross-checks the spec against the icon `vs` @location — icons previously had
// NO layout↔shader test.

const SHADER_SRC = emitIconWgsl()

describe('icon vertex-format single-source consistency', () => {
  it('spec shape: stride 36 (pos_px f32x2 + uv f32x2 + opacity + tint f32x3 + sdf)', () => {
    expect(ICON_FORMAT.stride).toBe(36)
    expect(ICON_FORMAT.fields.map((f) => [f.location, f.offset, f.vbFormat])).toEqual([
      [0, 0, 'float32x2'],
      [1, 8, 'float32x2'],
      [2, 16, 'float32'],
      [3, 20, 'float32x3'],
      [4, 32, 'float32'],
    ])
  })

  it('spec ↔ icon vs WGSL @location types match exactly', () => {
    expect(specShaderMismatches(ICON_FORMAT, SHADER_SRC, 'vs')).toEqual([])
  })
})
