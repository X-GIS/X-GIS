import { describe, it, expect } from 'vitest'
import { lint } from '../engine'
import { module, fn, f32T, smoothstep } from '../../../ir'
import { smoothstepEdgeOrder } from './smoothstep-edge-order'

const run = (m: ReturnType<typeof module>) => lint(m, [smoothstepEdgeOrder])

describe('smoothstep-edge-order (#841)', () => {
  it('flags constant edge0 > edge1 (undefined in GLSL ES)', () => {
    const m = module({
      funcs: [fn('rev', { x: f32T }, f32T, ({ x }) => smoothstep(1, 0, x))],
    })
    const ds = run(m)
    expect(ds.map((d) => d.ruleId)).toContain('smoothstep-edge-order')
    expect(ds[0]?.code).toBe('SD0108')
  })

  it('flags equal edges (division by zero inside the ramp)', () => {
    const m = module({
      funcs: [fn('eq', { x: f32T }, f32T, ({ x }) => smoothstep(0.5, 0.5, x))],
    })
    expect(run(m).map((d) => d.ruleId)).toContain('smoothstep-edge-order')
  })

  it('does not flag ascending edges', () => {
    const m = module({
      funcs: [fn('ok', { x: f32T }, f32T, ({ x }) => smoothstep(0, 1, x))],
    })
    expect(run(m)).toEqual([])
  })

  it('stays silent when an edge is not a literal (undecidable statically)', () => {
    const m = module({
      funcs: [fn('dyn', { x: f32T, e: f32T }, f32T, ({ x, e }) => smoothstep(e, 0, x))],
    })
    expect(run(m)).toEqual([])
  })
})
