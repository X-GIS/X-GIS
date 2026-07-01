import { describe, it, expect } from 'vitest'
import { emitTextWgsl } from '@xgis/map'
import { TEXT_FORMAT } from '@xgis/map'
import { specShaderMismatches } from '../render/__vertex-format-crosscheck'

// Single-source guard for the text glyph vertex format. TEXT_FORMAT drives the
// GPUVertexBufferLayout (text-renderer.ts) and the glyph packer's float slots;
// this cross-checks the spec against the text `vs` @location — text glyphs
// previously had NO layout↔shader test.

const SHADER_SRC = emitTextWgsl()

describe('text vertex-format single-source consistency', () => {
  it('spec shape: stride 16 (pos_px f32x2 + uv f32x2)', () => {
    expect(TEXT_FORMAT.stride).toBe(16)
    expect(TEXT_FORMAT.fields.map(f => [f.location, f.offset, f.vbFormat])).toEqual([
      [0, 0, 'float32x2'],
      [1, 8, 'float32x2'],
    ])
  })

  it('spec ↔ text vs WGSL @location types match exactly', () => {
    expect(specShaderMismatches(TEXT_FORMAT, SHADER_SRC, 'vs')).toEqual([])
  })
})
