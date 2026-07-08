// ═══ minifyShaderText / emit-prod transformText — token safety, directives, idempotence ═══

import { describe, it, expect } from 'vitest'
import { minifyShaderText, obfuscate } from '../emit-prod'
import { fn, module, vec2, vec4, sin, u32T, vec2fT, vec4fT } from './ir'
import { ioStruct, builtin, location } from './sot'
import { emitModule } from './backends/wgsl'
import { emitGlslModule } from './backends/glsl'

describe('minifyShaderText — string contracts', () => {
  it('keeps # directive lines verbatim on their own line', () => {
    const out = minifyShaderText('#version 300 es\nprecision highp float;\nfloat f() {\n  return 1.0;\n}\n')
    expect(out.split('\n')[0]).toBe('#version 300 es')
    expect(out).toBe('#version 300 es\nprecision highp float;float f(){return 1.0;}\n')
  })

  it('strips // comments (no string literals exist in WGSL/GLSL)', () => {
    expect(minifyShaderText('let x = 1.0; // the answer\nreturn x;\n')).toBe(
      'let x = 1.0;return x;\n',
    )
  })

  it('removes spaces only at structural punctuation — never between word tokens', () => {
    expect(minifyShaderText('fn f( a : f32 , b : f32 ) -> f32 {\n  return a ;\n}\n')).toBe(
      'fn f(a:f32,b:f32)-> f32{return a;}\n', // `)`+`->` is token-safe; `->`+`f32` keeps its space
    )
    // `float x` must keep its space; `a - -b`-style operator pairs are untouched.
    expect(minifyShaderText('float x = a - -b;\n')).toBe('float x = a - -b;\n')
  })

  it('is idempotent', () => {
    const once = minifyShaderText('float f ( ) {\n  return 1.0 ; // c\n}\n')
    expect(minifyShaderText(once)).toBe(once)
  })
})

// A small real module so the emit-integrated form is exercised end-to-end.
const VsOut = ioStruct('MinVsOut', {
  pos: builtin('position', vec4fT),
  uv: location(0, vec2fT),
})
const vs = fn(
  'vs_min',
  { idx: builtin('vertex_index', u32T) },
  () => VsOut.construct({ pos: vec4(0.0, 0.0, 0.0, 1.0), uv: vec2(0.0, 0.0) }),
  { stage: 'vertex' },
)
const fs = fn('fs_min', { vo: VsOut }, (p) => vec4(sin(p.vo.uv.x), 0.0, 0.0, 1.0), {
  stage: 'fragment',
  retAttr: '@location(0)',
})
const m = module({ funcs: [vs, fs], uses: [VsOut] })

describe('emit-prod transforms through the seam — integrated', () => {
  it('WGSL minifies to a single line (no directives) and shrinks', () => {
    const plain = emitModule(m)
    const min = emitModule(m, { transformText: minifyShaderText })
    expect(min.trimEnd().split('\n')).toHaveLength(1)
    expect(min.length).toBeLessThan(plain.length)
    expect(min).toContain('@vertex fn vs_min') // tokens intact, whitespace gone
  })

  it('GLSL keeps #version as line one; body is compacted; default emit is untouched', () => {
    const min = emitGlslModule(m, 'fragment', { transformText: minifyShaderText })
    expect(min.startsWith('#version 300 es\n')).toBe(true)
    expect(min.trimEnd().split('\n')).toHaveLength(2) // directive + one body line
    expect(min).toContain('precision highp float;')
    expect(emitGlslModule(m, 'fragment')).toContain('\n  ') // plain emit still indented
  })

  it('obfuscate() bundles mangle + minify and keeps the ABI names', () => {
    const renames = new Map<string, string>()
    const wgsl = emitModule(m, obfuscate({ renames }))
    expect(wgsl.trimEnd().split('\n')).toHaveLength(1)
    expect(wgsl).not.toContain('MinVsOut') // plain struct mangled…
    expect(wgsl).toContain('fn vs_min') // …entry names intact
    expect(renames.get('MinVsOut')).toMatch(/^_S\d+$/)
  })
})
