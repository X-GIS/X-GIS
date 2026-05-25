import { describe, expect, it } from 'vitest'
import {
  fn, module, f32, vec2, vec3, vec2fT, f32T, boolT, u32T,
  param, constRef, clamp, log, tan, min, dot,
  type ConstDecl,
} from './ir'
import { emitModule, emitFunc } from './backend-wgsl'
import { compileModule } from './backend-cpu'

const CONSTS: ConstDecl[] = [
  { name: 'PI', type: f32T, wgslValue: 3.14159265, cpuValue: Math.PI },
  { name: 'DEG2RAD', type: f32T, wgslValue: 0.01745329, cpuValue: Math.PI / 180 },
  { name: 'EARTH_R', type: f32T, wgslValue: 6378137, cpuValue: 6378137 },
]

describe('shader-dsl IR — type inference', () => {
  it('vec * scalar = vec; vec.x = f32; compare = bool', () => {
    const v = vec2(f32(1), f32(2))
    expect(v.type).toEqual(vec2fT)
    expect(v.mul(f32(3)).type).toEqual(vec2fT) // vec * scalar → vec
    expect(v.x.type).toEqual(f32T) // .x → f32
    expect(f32(1).lt(f32(2)).type).toEqual(boolT) // compare → bool
    expect(dot(v, v).type).toEqual(f32T) // dot → f32
  })

  it('mismatched vector op is a TS compile error AND a runtime throw (AC4)', () => {
    // The phantom key on Node<K> makes vec2 + vec3 a compile error; the
    // runtime binResultType also throws as a second layer. The directive below
    // asserts the compile-time rejection — a regression that lets it type-check
    // makes the directive "unused" and fails the build.
    // @ts-expect-error vec2.add(vec3) — mismatched vector keys
    expect(() => vec2(f32(1), f32(2)).add(vec3(f32(1), f32(2), f32(3)))).toThrow()
  })

  it('scalar promotion f32 > i32 > u32', () => {
    const a = param('a', f32T), b = param('b', u32T)
    expect(a.add(b).type).toEqual(f32T)
  })
})

// A trivial projection-shaped function exercising let/return/builtins/consts.
const merc = fn('merc', { lon: f32T, lat: f32T }, vec2fT, (b, p) => {
  const PI = constRef('PI'), DEG2RAD = constRef('DEG2RAD'), EARTH_R = constRef('EARTH_R')
  const clamped = b.let('clamped', clamp(p.lat, f32(-85.051129), f32(85.051129)))
  const x = b.let('x', p.lon.mul(DEG2RAD).mul(EARTH_R))
  const y = b.let('y', log(tan(PI.div(4).add(clamped.mul(DEG2RAD).div(2)))).mul(EARTH_R))
  b.ret(vec2(x, y))
})

describe('shader-dsl WGSL backend', () => {
  it('emits a well-formed fn with parenthesised math and consts', () => {
    const wgsl = emitModule(module({ consts: CONSTS, funcs: [merc] }))
    expect(wgsl).toContain('const PI: f32 = 3.14159265;')
    expect(wgsl).toContain('const DEG2RAD: f32 = 0.01745329;')
    expect(wgsl).toContain('const EARTH_R: f32 = 6378137.0;')
    expect(wgsl).toContain('fn merc(lon: f32, lat: f32) -> vec2<f32>')
    expect(wgsl).toContain('clamp(lat, -85.051129, 85.051129)')
    expect(wgsl).toContain('return vec2<f32>(x, y);')
    // balanced braces
    const open = (wgsl.match(/{/g) ?? []).length
    const close = (wgsl.match(/}/g) ?? []).length
    expect(open).toBe(close)
  })

  it('emitFunc on a single func works standalone', () => {
    expect(emitFunc(merc)).toContain('fn merc(')
  })
})

describe('shader-dsl CPU backend', () => {
  it('interprets the same IR in f64 and matches a hand reference', () => {
    const mod = compileModule(module({ consts: CONSTS, funcs: [merc] }))
    const DEG = Math.PI / 180, R = 6378137
    const ref = (lon: number, lat: number): [number, number] => {
      const c = Math.max(-85.051129, Math.min(85.051129, lat))
      return [lon * DEG * R, Math.log(Math.tan(Math.PI / 4 + (c * DEG) / 2)) * R]
    }
    for (const [lon, lat] of [[0, 0], [127, 37], [-150, -60], [179, 84]] as const) {
      const got = mod.fns.merc(lon, lat) as number[]
      const [rx, ry] = ref(lon, lat)
      expect(got[0]).toBeCloseTo(rx, 6)
      expect(got[1]).toBeCloseTo(ry, 6)
    }
  })

  it('imperative control flow: if/var/assign/for/min round-trips', () => {
    // sum of min(i, 3) for i in [0,5) via a for-loop + compound assign.
    const f = fn('acc', {}, f32T, (b) => {
      const total = b.var('total', f32T, f32(0))
      b.forRange('i', f32(0), (i) => i.lt(f32(5)), (b, i) => {
        b.addAssign(total, min(i, f32(3)))
      })
      b.ret(total)
    })
    const mod = compileModule(module({ funcs: [f] }))
    // 0+1+2+3+3 = 9
    expect(mod.fns.acc()).toBe(9)
  })
})
