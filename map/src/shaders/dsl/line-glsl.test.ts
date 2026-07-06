import { describe, it, expect } from 'vitest'
import { emitLineGlsl } from './line'

// #834 M5 slice 1 — the GLSL ES 3.00 twin of the line shader emits, splits
// per stage, and lowers its three array<Struct> storage buffers (segments /
// shapes / shape_segments) to R32F data textures. The real-WebGL2 compile
// proof is the _line-glsl-compile-gate e2e spec; these pin the emitted shape
// so a DSL regression fails fast in unit CI.

describe('emitLineGlsl — GLSL twin shape (#834 M5)', () => {
  it('vertex stage: single main, instance/vertex builtin glue, storage lowered', () => {
    const vs = emitLineGlsl(false, 'vertex')
    expect(vs).toContain('#version 300 es')
    expect((vs.match(/void main\(\)/g) ?? []).length).toBe(1)
    // Instanced segment quad: both builtins feed vs_line.
    expect(vs).toMatch(/gl_VertexID/)
    expect(vs).toMatch(/gl_InstanceID/)
    // emulateStorage: no storage buffers survive; data textures + texelFetch do.
    expect(vs).not.toMatch(/\bbuffer\s+\w/)
    expect(vs).toContain('texelFetch')
  })

  it('fragment stage: single main, no pattern entry, uniform block tagged', () => {
    const fs = emitLineGlsl(false, 'fragment')
    expect(fs).toContain('#version 300 es')
    expect((fs.match(/void main\(\)/g) ?? []).length).toBe(1)
    // The stage split keeps fs_line only — the pattern/max variants are
    // separate entries and must not leak extra mains or dead pattern code.
    expect(fs).not.toContain('fs_line_pattern')
    expect(fs).not.toContain('fs_line_max')
  })
})
