import { describe, expect, it } from 'vitest'
import { module, fn, vec2fT, vec3fT, smoothstep, fma, atan2 } from './index.js'
import { compileModule } from '../oracle.js'

// ═══ CPU-oracle VECTOR parity for smoothstep / fma / atan2 ═══
//
// All three are component-wise over vecN<f32> in WGSL AND GLSL ES 3.00, and all
// three vector forms are reachable from the authoring surface (smoothstep's #763
// X15 overload; fma/atan2's unconstrained `K extends string`). The CPU builtins
// evaluated them with scalar `as number` casts, so a vector call emitted valid
// WGSL/GLSL and silently returned NaN on the CPU oracle (JS array arithmetic) —
// the plausible-wrong failure mode the oracle exists to refuse. Each case pins
// the component-wise result the GPU targets compute. Scalar behaviour is pinned
// separately (stdlib-builtins.test.ts smoothstep; oracle suites for atan2/fma).

describe('CPU oracle — vector smoothstep/fma/atan2 (component-wise, as WGSL computes them)', () => {
  it('smoothstep over vec3 operands is component-wise (was: silent NaN)', () => {
    const f = compileModule(
      module({
        funcs: [
          fn('f', { e0: vec3fT, e1: vec3fT, x: vec3fT }, vec3fT, ({ e0, e1, x }, b) =>
            b.ret(smoothstep(e0, e1, x)),
          ),
        ],
      }),
    ).fns.f
    // t=0 / t=0.5 / t=1 per component: 0, 0.5²·(3−2·0.5)=0.5, 1.
    expect(f([0, 0, 0], [1, 1, 1], [0, 0.5, 1])).toEqual([0, 0.5, 1])
  })

  it('fma over vec2 operands is component-wise (was: silent NaN)', () => {
    const f = compileModule(
      module({
        funcs: [
          fn('f', { a: vec2fT, b: vec2fT, c: vec2fT }, vec2fT, ({ a, b, c }, bl) =>
            bl.ret(fma(a, b, c)),
          ),
        ],
      }),
    ).fns.f
    expect(f([2, 3], [4, 5], [1, 1])).toEqual([9, 16])
  })

  it('atan2 over vec2 operands is component-wise (was: silent NaN)', () => {
    const f = compileModule(
      module({
        funcs: [fn('f', { y: vec2fT, x: vec2fT }, vec2fT, ({ y, x }, b) => b.ret(atan2(y, x)))],
      }),
    ).fns.f
    expect(f([1, 0], [1, 1])).toEqual([Math.PI / 4, 0])
  })
})
