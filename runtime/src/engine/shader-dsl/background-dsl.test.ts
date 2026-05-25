import { describe, it, expect } from 'vitest'
import { emitBgWgsl, buildBgModule } from './background'
import { compileModule } from './backend-cpu'

// Phase-2: the background shader is DSL-emitted. The pick variant (formerly the
// __PICK_*__ String.replace markers) is conditional emission — covered here
// since renderer-shader-markers.test.ts no longer tracks bg.
describe('Phase-2 background shader — DSL emission', () => {
  it('non-pick: base structs + entries, no pick varying/output', () => {
    const w = emitBgWgsl(false)
    expect(w).toContain('@group(0) @binding(0) var<uniform> u: U;')
    expect(w).toContain('@builtin(position) pos: vec4<f32>,')
    expect(w).toContain('@location(0) color: vec4<f32>,')
    expect(w).toContain('@vertex\nfn vs(@builtin(vertex_index) idx: u32) -> VOut')
    expect(w).toContain('@fragment\nfn fs(in: VOut) -> FOut')
    expect(w).toContain('array<vec2<f32>, 6>(')
    expect(w).toContain('(u.mvp * vec4<f32>(local, 0.0, 1.0))')
    expect(w).not.toContain('pick')
    expect(w).not.toContain('@interpolate(flat)')
    expect((w.match(/{/g) ?? []).length).toBe((w.match(/}/g) ?? []).length)
    expect((w.match(/\(/g) ?? []).length).toBe((w.match(/\)/g) ?? []).length)
  })

  it('pick: adds the flat varying + pick output + the pick write', () => {
    const w = emitBgWgsl(true)
    expect(w).toContain('@location(0) @interpolate(flat) _pad: u32,')
    expect(w).toContain('@location(1) pick: vec2<u32>,')
    expect(w).toContain('out.pick = vec2<u32>(0u, 0u);')
    expect((w.match(/{/g) ?? []).length).toBe((w.match(/}/g) ?? []).length)
  })

  it('cpu vs: world-extent quad, camera-relative, MVP-applied', () => {
    const M = compileModule(buildBgModule(false))
    const mvp = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] // identity
    M.setBinding('u', { mvp, cam_center: [100, 200], _pad: [0, 0], color: [0.1, 0.2, 0.3, 1] } as unknown as never)
    const X = 40075016.686 * 2.5, Y = 20037508.34
    const verts: Array<[number, number]> = [[-X, -Y], [X, -Y], [-X, Y], [-X, Y], [X, -Y], [X, Y]]
    for (let i = 0; i < 6; i++) {
      const out = M.fns.vs(i) as { pos: number[] }
      expect(out.pos[0]).toBeCloseTo(verts[i]![0] - 100, 2)
      expect(out.pos[1]).toBeCloseTo(verts[i]![1] - 200, 2)
      expect(out.pos[2]).toBeCloseTo(0, 6)
      expect(out.pos[3]).toBeCloseTo(1, 6)
    }
  })
})
