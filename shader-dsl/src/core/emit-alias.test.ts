// ═══ aliasShaderTypes / emit-prod aliasTypes() — payback, capture safety, ABI ═══

import { describe, it, expect } from 'vitest'
import { aliasShaderTypes, mangle, minify, obfuscate } from '../emit-prod.js'
import { fn, module, vec2, vec4, sin, u32T, vec2fT, vec4fT } from './ir/index.js'
import { ioStruct, builtin, location } from './sot.js'
import { emitModule } from './backends/wgsl.js'
import { emitGlslModule } from './backends/glsl.js'

const wgslSrc = (uses: number): string =>
  `fn f(${Array.from({ length: uses }, (_, i) => `p${i}: vec2<f32>`).join(', ')}) -> f32 {\n` +
  `  return p0.x;\n}\n`

describe('aliasShaderTypes — declaration syntax per target', () => {
  it('WGSL gets `alias`, and every spelling including constructor position is rewritten', () => {
    const out = aliasShaderTypes(
      'fn f(p: vec2<f32>, q: vec2<f32>, r: vec2<f32>) -> vec2<f32> {\n' +
        '  return vec2<f32>(1.0, 2.0) + vec2<f32>(3.0, 4.0) + p + q + r;\n}\n',
    )
    expect(out.split('\n')[0]).toBe('alias a=vec2<f32>;')
    expect(out).not.toMatch(/vec2<f32>\(/) // constructor rewritten too…
    expect(out).toContain('a(1.0, 2.0)')
    expect(out.match(/vec2<f32>/g)).toHaveLength(1) // …and the ONLY survivor is the decl
  })

  it('GLSL gets `#define`, placed after #version, and keeps `precision` alone', () => {
    const src =
      '#version 300 es\nprecision highp float;\n' +
      `vec2 f(${Array.from({ length: 9 }, (_, i) => `vec2 p${i}`).join(', ')}) {\n  return p0;\n}\n`
    const out = aliasShaderTypes(src)
    const lines = out.split('\n')
    expect(lines[0]).toBe('#version 300 es') // the directive MUST stay first
    expect(lines[1]).toBe('#define a vec2')
    // A macro-expanded `precision highp a;` is a corner the Tint/ANGLE probe did
    // not cover, so a type carrying a precision qualifier is never rewritten.
    expect(out).toContain('precision highp float;')
  })
})

describe('aliasShaderTypes — when it declines', () => {
  it('skips a type that does not pay for its own declaration', () => {
    expect(aliasShaderTypes(wgslSrc(1))).toBe(wgslSrc(1)) // 1 use: never
    expect(aliasShaderTypes(wgslSrc(2))).toBe(wgslSrc(2)) // 2 uses: still under
    expect(aliasShaderTypes(wgslSrc(9))).toContain('alias ') // …enough uses, taken
  })

  it('is idempotent — a second run finds nothing left that pays', () => {
    const once = aliasShaderTypes(wgslSrc(9))
    expect(aliasShaderTypes(once)).toBe(once)
  })

  it('never takes a name that already occurs — a #define would capture it', () => {
    // `a`..`d` are live identifiers here, so the first free name is `e`.
    const src =
      '#version 300 es\nfloat g(float a, float b, float c, float d) {\n' +
      '  float e0 = a + b + c + d;\n  return e0 + float(1) + float(2) + float(3);\n}\n'
    const out = aliasShaderTypes(src)
    expect(out).toContain('#define e float')
    expect(out).toMatch(/e g\(e a, e b, e c, e d\)/) // params renamed by TYPE, not by name
    expect(out).toContain('e0') // the identifier that starts with the alias is untouched
  })
})

// A real module, so the preset is exercised end-to-end.
const VsOut = ioStruct('AliasVsOut', {
  pos: builtin('position', vec4fT),
  uv: location(0, vec2fT),
})
const vs = fn(
  'vs_alias',
  { idx: builtin('vertex_index', u32T) },
  () => VsOut.construct({ pos: vec4(0.0, 0.0, 0.0, 1.0), uv: vec2(0.0, 0.0) }),
  { stage: 'vertex' },
)
const fs = fn('fs_alias', { vo: VsOut }, (p) => vec4(sin(p.vo.uv.x), 0.0, 0.0, 1.0), {
  stage: 'fragment',
  retAttr: '@location(0)',
})
const m = module({ funcs: [vs, fs], uses: [VsOut] })

describe('aliasTypes() through the { plugins } seam', () => {
  it('is in obfuscate(), and shrinks what mangle + minify alone reach', () => {
    const without = emitModule(m, { plugins: [mangle(), minify()] })
    const with_ = emitModule(m, { plugins: obfuscate() })
    expect(with_.length).toBeLessThan(without.length)
    expect(with_.trimEnd().split('\n')).toHaveLength(1) // still one WGSL line
  })

  it('leaves the ABI spellings alone — binding, entry and field names', () => {
    const wgsl = emitModule(m, { parens: 'minimal', plugins: obfuscate() })
    expect(wgsl).toContain('fn vs_alias')
    expect(wgsl).toContain('fn fs_alias')
    expect(wgsl).toContain('pos')
    expect(wgsl).toContain('uv')
  })

  it('GLSL: the two stages may pick different letters — types resolve before linking', () => {
    // Alias assignment is per-SHADER (it is a count of that shader's spellings),
    // so the stages need not agree. That is safe precisely because a `#define`
    // expands before parsing: a varying declared `out l uv;` and read `in q uv;`
    // are both `vec2 uv` by the time the linker compares them. The link itself is
    // gated on real ANGLE by _emit-obfuscate-gate.spec.ts.
    const v = emitGlslModule(m, 'vertex', { plugins: obfuscate() })
    const f = emitGlslModule(m, 'fragment', { plugins: obfuscate() })
    expect(v.startsWith('#version 300 es\n')).toBe(true)
    expect(f.startsWith('#version 300 es\n')).toBe(true)
    expect(v).toContain('out vec2 uv;') // the varying keeps its ABI spelling…
    expect(f).toContain('in vec2 uv;') // …on both sides
  })
})
