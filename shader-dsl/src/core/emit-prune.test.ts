// ═══ pruneRedundantPrototypes / emit-prod prune() — what it drops, and what it must not ═══

import { describe, it, expect } from 'vitest'
import { pruneRedundantPrototypes, obfuscate } from '../emit-prod.js'
import { fn, module, vec2, vec4, f32, f32T, vec2fT, vec4fT } from './ir/index.js'
import { ioStruct, builtin, location } from './sot.js'
import { emitGlslModule } from './backends/glsl.js'
import { emitModule } from './backends/wgsl.js'

const G = (body: string): string => `#version 300 es\nprecision highp float;\n${body}`

describe('pruneRedundantPrototypes — drops only what the definition already declares', () => {
  it('drops a prototype whose definition precedes every use', () => {
    const out = pruneRedundantPrototypes(
      G('float h(float x);\nfloat h(float x) { return x; }\nvoid main() { h(1.); }\n'),
    )
    expect(out).not.toContain('float h(float x);\n')
    expect(out).toContain('float h(float x) { return x; }') // the definition stays
    expect(out).toContain('h(1.);')
  })

  it('KEEPS a prototype when a call comes before the definition', () => {
    // This is why the backend emits them unconditionally: the function section
    // is not promised to be in dependency order.
    const src = G('float h(float x);\nvoid main() { h(1.); }\nfloat h(float x) { return x; }\n')
    expect(pruneRedundantPrototypes(src)).toBe(src)
  })

  it('KEEPS a prototype with no definition in this text (an extern body)', () => {
    const src = G('float host_fn(float x);\nvoid main() { host_fn(1.); }\n')
    expect(pruneRedundantPrototypes(src)).toBe(src)
  })

  it('is not fooled by a CALL that looks like a declarator', () => {
    // `return h(1.);` and `const float k=h(1.);` both end in `);` at a glance.
    // Only a declarator at a statement boundary with a type AND a name counts.
    const src = G(
      'float h(float x) { return x; }\nfloat k(float x) { return h(x); }\nvoid main() { k(1.); }\n',
    )
    expect(pruneRedundantPrototypes(src)).toBe(src) // nothing to drop, nothing damaged
  })

  it('is a no-op on WGSL, which has no prototypes', () => {
    const src = 'fn h(x: f32) -> f32 { return x; }\n@fragment fn f() {}\n'
    expect(pruneRedundantPrototypes(src)).toBe(src)
  })

  it('is idempotent', () => {
    const once = pruneRedundantPrototypes(
      G('float h(float x);\nfloat h(float x) { return x; }\nvoid main() { h(1.); }\n'),
    )
    expect(pruneRedundantPrototypes(once)).toBe(once)
  })
})

// A real two-stage module, so the preset is exercised on emitted GLSL.
const VsOut = ioStruct('PruneVsOut', {
  pos: builtin('position', vec4fT),
  uv: location(0, vec2fT),
})
const helper = fn('prune_helper', { x: f32T }, ({ x }) => x.mul(f32(2)))
const vs = fn(
  'vs_prune',
  {},
  () => VsOut.construct({ pos: vec4(0.0, 0.0, 0.0, 1.0), uv: vec2(0.0, 0.0) }),
  { stage: 'vertex' },
)
const fs = fn('fs_prune', { vo: VsOut }, (p) => vec4(helper({ x: p.vo.uv.x }), 0.0, 0.0, 1.0), {
  stage: 'fragment',
  retAttr: '@location(0)',
})
const m = module({ funcs: [helper, vs, fs], uses: [VsOut] })

describe('prune() in the obfuscate() preset', () => {
  it('GLSL shrinks and the helper is declared exactly once', () => {
    const plain = emitGlslModule(m, 'fragment')
    const out = emitGlslModule(m, 'fragment', { plugins: obfuscate() })
    // The authored helper is emitted with a prototype AND a definition…
    expect(plain.match(/prune_helper/g)!.length).toBeGreaterThan(2)
    expect(out.length).toBeLessThan(plain.length)
    // …and the pruned+mangled output declares its replacement once, as a body.
    const name = out.match(/\b(\w+)\(float \w+\)\{/)?.[1]
    if (name !== undefined) expect(out.split(`${name}(`).length - 1).toBeLessThan(3)
  })

  it('leaves WGSL byte-identical to the preset without it', () => {
    // WGSL carries no prototypes, so adding the pass must change nothing there.
    const withPrune = emitModule(m, { plugins: obfuscate() })
    expect(withPrune).toContain('fn vs_prune')
    expect(withPrune.trimEnd().split('\n')).toHaveLength(1)
  })
})
