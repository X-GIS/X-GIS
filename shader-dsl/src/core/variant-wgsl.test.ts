// ═══ validateVariantsWgsl — the aggregation, driven by a recorder (#1715) ═══
//
// The REAL run goes through a browser's Tint (`playground/e2e/_variant-wgsl-gate.spec.ts`).
// What is tested here is everything around it: that every variant is attempted, that an
// error is attributed to the right key, that warnings are not failures, and — the arm that
// matters most — that a module which reports errors is NOT reported ok.
//
// That last one is the trap this API is shaped around: `createShaderModule` does NOT throw
// on invalid WGSL. A validator written as `try { createShaderModule() } catch {}` passes on
// every broken shader, silently, forever.

import { describe, it, expect } from 'vitest'
import { fn, module, vec4, vec4fT, f32T } from './ir/index.js'
import { builtin, ioStruct } from './sot.js'
import { variantFamily } from './variant-family.js'
import { validateVariantsWgsl, type WgslMessage, type WgslValidator } from './variant-link.js'

const VsOut = ioStruct('WgOut', { pos: builtin('position', vec4fT) })

/** Two points, genuinely different programs (an uncalled helper would be DCE'd and every
 *  key would emit identical bytes — the non-vacuity trap `variant-family.test.ts` records). */
const family = variantFamily({
  axes: { hi: [false, true] } as const,
  build: ({ hi }) => {
    const lift = fn('wg_lift', { t: f32T }, (p) => p.t.mul(hi ? 3.0 : 1.0))
    return module({
      uses: [VsOut],
      funcs: [
        lift,
        fn('vs_w', {}, () => VsOut.construct({ pos: vec4(lift({ t: 1.0 }), 0, 0, 1) }), {
          stage: 'vertex',
        }),
      ],
    })
  },
  key: ({ hi }) => (hi ? 'hi' : 'lo'),
})

/** A recorder device: records every source handed to it and replays scripted messages. */
function recorder(messagesFor: (code: string) => readonly WgslMessage[]) {
  const seen: string[] = []
  const device: WgslValidator = {
    createShaderModule({ code }) {
      seen.push(code)
      return { getCompilationInfo: () => Promise.resolve({ messages: messagesFor(code) }) }
    },
  }
  return { device, seen }
}

describe('validateVariantsWgsl', () => {
  it('attempts EVERY variant, in key order, and reports ok when Tint is silent', async () => {
    const { device, seen } = recorder(() => [])
    const res = await validateVariantsWgsl(device, family)
    expect(res.map((r) => r.key)).toEqual(family.keys)
    expect(res.every((r) => r.ok)).toBe(true)
    // Non-vacuity: the device really was called, once per key, with DIFFERENT sources.
    expect(seen.length).toBe(2)
    expect(new Set(seen).size).toBe(2)
  })

  it('an error message makes that variant NOT ok — a silent createShaderModule is the trap', async () => {
    // The module is created without throwing; only getCompilationInfo() says it is broken.
    const { device } = recorder((code) =>
      code.includes('3.0') ? [{ type: 'error', message: 'unresolved value', lineNum: 7 }] : [],
    )
    const res = await validateVariantsWgsl(device, family)
    const bad = res.filter((r) => !r.ok)
    expect(bad.map((r) => r.key)).toEqual(['hi'])
    expect(bad[0]!.failedAt).toBe('validate')
    expect(bad[0]!.errors?.[0]).toContain('L7: unresolved value')
    // …and the OTHER variant stays ok, so the failure is attributed rather than smeared.
    expect(res.find((r) => r.key === 'lo')?.ok).toBe(true)
  })

  it('warnings and info are not failures', async () => {
    const { device } = recorder(() => [
      { type: 'warning', message: 'unused variable' },
      { type: 'info', message: 'note' },
    ])
    expect((await validateVariantsWgsl(device, family)).every((r) => r.ok)).toBe(true)
  })

  it('a throwing device is reported, not swallowed', async () => {
    const device: WgslValidator = {
      createShaderModule() {
        throw new Error('device lost')
      },
    }
    const res = await validateVariantsWgsl(device, family)
    expect(res.every((r) => !r.ok && r.failedAt === 'validate')).toBe(true)
    expect(res[0]!.errors?.[0]).toContain('device lost')
  })

  it('an emit failure is reported against every key, with attribution refused', async () => {
    // Same rule as the GL side: emit is per-family, so nothing here can say WHICH variant
    // broke it, and a guess would send the reader to the wrong one.
    //
    // Driven by a stub family rather than a module that happens to throw today: the branch
    // under test is "emit threw", and tying it to whichever DSL construct currently rejects
    // would make this test fail the day that construct becomes legal — for a reason that
    // has nothing to do with the aggregation it checks.
    const throwing = {
      ...family,
      emit: () => {
        throw new Error('capability x is not spellable on this target')
      },
    } as unknown as typeof family
    const { device, seen } = recorder(() => [])
    const res = await validateVariantsWgsl(device, throwing)
    expect(res.map((r) => r.key)).toEqual(family.keys)
    expect(res.every((r) => !r.ok && r.failedAt === 'emit')).toBe(true)
    expect(res[0]!.errors?.[0]).toContain('capability x is not spellable')
    expect(res[0]!.errors?.[0]).toContain('attribution unavailable')
    // The device is never reached, so a green here could not come from a silent validator.
    expect(seen).toEqual([])
  })
})
