// ═══ shader-dsl — MRT emit gate (#847) ═══
//
// Pins the multi-@location fragment-output path on both backends: WGSL keeps
// the location attributes on the output struct, GLSL ES 3.00 scatters them
// into layout-qualified draw buffers. The real-GPU sibling (two attachments,
// drawBuffers, per-attachment readback) is
// playground/e2e/_shader-dsl-mrt-render.spec.ts.

import { describe, it, expect } from 'vitest'
import { mrtGateModule } from './_mrt-gate.ts'
import { emitModule, emitGlslModule, reflect } from '../src/index.ts'

describe('MRT (multi-@location fragment output)', () => {
  it('WGSL: the output struct carries both draw-buffer locations', () => {
    const wgsl = emitModule(mrtGateModule)
    expect(wgsl).toContain('@location(0) color0: vec4<f32>')
    expect(wgsl).toContain('@location(1) color1: vec4<f32>')
  })

  it('GLSL ES 3.00: two layout-qualified draw buffers, scattered from the struct return', () => {
    const fsSrc = emitGlslModule(mrtGateModule, 'fragment')
    expect(fsSrc).toContain('layout(location = 0) out vec4 color0;')
    expect(fsSrc).toContain('layout(location = 1) out vec4 color1;')
    // the shared fullscreen vertex stage still carries the gl_VertexID cast
    const vsSrc = emitGlslModule(mrtGateModule, 'vertex')
    expect(vsSrc).toContain('uint(gl_VertexID)')
  })

  it('reflection reports the struct output on the fragment entry', () => {
    const r = reflect(mrtGateModule)
    const frag = r.entries.find((e) => e.stage === 'fragment')
    expect(frag?.output).toBe('struct:FsOut')
  })
})
