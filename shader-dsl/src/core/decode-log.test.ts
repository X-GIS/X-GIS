// ═══ decodeShaderLog / invertRenames — the half that USES the source map ═══

import { describe, it, expect } from 'vitest'
import { obfuscate, decodeShaderLog, invertRenames } from '../emit-prod.js'
import { emitModule } from './backends/wgsl.js'
import { fn, module, f32, f32T, Var, If } from './ir/index.js'

describe('decodeShaderLog', () => {
  it('replaces a uniquely-invertible name and leaves the prose alone', () => {
    const renames = new Map([
      ['terrain_shade', 'b'],
      ['vec2<f32>', 'l'],
    ])
    expect(decodeShaderLog("no matching overload in 'b' for arg of type 'l'", renames)).toBe(
      "no matching overload in 'terrain_shade' for arg of type 'vec2<f32>'",
    )
  })

  it('never substring-replaces — a short alias inside a longer word is not a hit', () => {
    const renames = new Map([['helper', 'b']])
    expect(decodeShaderLog('abs(b) at bank_b, b2, _b', renames)).toBe(
      'abs(helper) at bank_b, b2, _b',
    )
  })

  it('annotates rather than guesses when a name inverts to several', () => {
    // Function-scoped names REUSE the short alphabet across functions, so `f`
    // legitimately came from more than one authored name. Picking one would be
    // a guess the log cannot support.
    const renames = new Map([
      ['noise.coordinate', 'f'],
      ['shade.tint', 'f'],
    ])
    expect(decodeShaderLog('undeclared identifier f', renames)).toBe(
      'undeclared identifier f⟨coordinate (in noise) | tint (in shade)⟩',
    )
  })

  it('is identity for an empty map, and for a log naming nothing renamed', () => {
    expect(decodeShaderLog('boom', new Map())).toBe('boom')
    expect(decodeShaderLog('boom', new Map([['a', 'b']]))).toBe('boom')
  })
})

describe('invertRenames — key shapes', () => {
  it('qualifies a function-scoped key and passes a type spelling through', () => {
    const t = invertRenames(
      new Map([
        ['noise.coordinate', 'f'],
        ['vec2<f32>', 'l'],
        ['terrain_shade', 'b'],
      ]),
    )
    expect(t.get('f')?.authored).toEqual(['coordinate (in noise)'])
    expect(t.get('l')?.authored).toEqual(['vec2<f32>']) // NOT read as `vec2<f32` + `>`
    expect(t.get('b')?.authored).toEqual(['terrain_shade'])
  })
})

describe('a real obfuscate() round trip', () => {
  const m = module({
    funcs: [
      fn('terrain_shade', { coordinate: f32T }, ({ coordinate }) => {
        const acc = Var(coordinate.mul(f32(2)))
        If(coordinate.gt(f32(1)), () => acc.assign(acc.add(f32(0.5))))
        return acc
      }),
      fn('vs_main', {}, () => f32(1), { stage: 'vertex' }),
    ],
  })

  it('every authored name the emit dropped can be recovered from the map', () => {
    const renames = new Map<string, string>()
    const wgsl = emitModule(m, { parens: 'minimal', plugins: obfuscate({ renames }) })
    expect(wgsl).not.toContain('terrain_shade') // …gone from the shipped text…
    expect(wgsl).not.toContain('coordinate')

    const emittedFn = renames.get('terrain_shade')!
    const emittedParam = renames.get('terrain_shade.coordinate')!
    expect(wgsl).toContain(`fn ${emittedFn}(${emittedParam}:`)
    // …and a driver log naming them comes back readable.
    expect(decodeShaderLog(`error in ${emittedFn}: bad arg ${emittedParam}`, renames)).toContain(
      'error in terrain_shade',
    )
  })
})
