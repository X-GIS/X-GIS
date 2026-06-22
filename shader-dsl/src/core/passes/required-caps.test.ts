import { describe, it, expect } from 'vitest'
import { requiredCaps, assertCaps } from './required-caps'
import { wgslBackend } from '../backends/wgsl'
import { glslEs300Backend, UnsupportedFeatureError } from '../backends/glsl'
import { module, fn, f32, f32T, arrayT, computeFn } from '../ir'

// #9 — the capability model wired into emit. A module declares the GPU features
// it needs (requiredCaps); emit asserts the target backend covers them and fails
// closed (UnsupportedFeatureError) otherwise — never a silent mis-emit.
const storageMod = () => module({
  bindings: [{ group: 0, binding: 0, name: 'buf', space: 'storage' as const, access: 'read' as const, type: arrayT(f32T) }],
})

describe('capabilities — requiredCaps + assertCaps (#9)', () => {
  it('a storage binding requires storageBuffer', () => {
    expect(requiredCaps(storageMod())).toContain('storageBuffer')
  })

  it('a @compute entry requires compute', () => {
    const m = module({ funcs: [computeFn('cs', 64, 'gid', () => { /* empty */ })] })
    expect(requiredCaps(m)).toContain('compute')
  })

  it('a pure module requires nothing', () => {
    const m = module({ funcs: [fn('k', {}, f32T, (_p, b) => { b.ret(f32(1)) })] })
    expect(requiredCaps(m)).toHaveLength(0)
  })

  it('assertCaps throws UnsupportedFeatureError when the backend lacks a cap', () => {
    expect(() => assertCaps(glslEs300Backend, storageMod())).toThrow(UnsupportedFeatureError)
  })

  it('assertCaps passes when the backend covers all required caps (wgsl)', () => {
    expect(() => assertCaps(wgslBackend, storageMod())).not.toThrow()
  })
})
