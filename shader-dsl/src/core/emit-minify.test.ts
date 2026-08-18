// ═══ minifyShaderText / emit-prod transformText — token safety, directives, idempotence ═══

import { describe, it, expect } from 'vitest'
import { minifyShaderText, mangle, minify, obfuscate } from '../emit-prod.js'
import { fn, module, vec2, vec4, sin, u32T, vec2fT, vec4fT } from './ir/index.js'
import { ioStruct, builtin, location } from './sot.js'
import { emitModule } from './backends/wgsl.js'
import { emitGlslModule } from './backends/glsl.js'

describe('minifyShaderText — string contracts', () => {
  it('keeps # directive lines verbatim on their own line', () => {
    const out = minifyShaderText(
      '#version 300 es\nprecision highp float;\nfloat f() {\n  return 1.0;\n}\n',
    )
    expect(out.split('\n')[0]).toBe('#version 300 es')
    expect(out).toBe('#version 300 es\nprecision highp float;float f(){return 1.;}\n')
  })

  it('strips // line comments and /* */ block comments (no string literals exist)', () => {
    expect(minifyShaderText('let x = 1.0; // the answer\nreturn x;\n')).toBe('let x=1.;return x;\n')
    expect(minifyShaderText('let /* mid */ x = 2.0; /* tail\nspans lines */ return x;\n')).toBe(
      'let x=2.;return x;\n',
    )
  })

  it('drops every separator maximal munch does not need', () => {
    expect(minifyShaderText('fn f( a : f32 , b : f32 ) -> f32 {\n  return a ;\n}\n')).toBe(
      'fn f(a:f32,b:f32)->f32{return a;}\n', // `)->f32` joins; `return a` cannot
    )
    expect(minifyShaderText('float x = a * b + c;\n')).toBe('float x=a*b+c;\n')
  })

  it('keeps the separator wherever omitting it would MERGE two tokens', () => {
    expect(minifyShaderText('float x = a - -b;\n')).toBe('float x=a- -b;\n') // `- -` ≠ `--`
    expect(minifyShaderText('float x = a / / b;\n')).toBe('float x=a/ /b;\n') // `//` = comment
    expect(minifyShaderText('var v: array<vec2<f32> >;\n')).toBe('var v:array<vec2<f32> >;\n') // `> >` ≠ `>>`
    expect(minifyShaderText('let x = 1.0 f;\n')).toBe('let x=1. f;\n') // number/word never merge
    // …but a pair with no longer form joins: `<<` then `-` is not an operator.
    expect(minifyShaderText('int x = a << -b;\n')).toBe('int x=a<<-b;\n')
  })

  it('canonicalises numeric literals losslessly — value and float-ness preserved', () => {
    // `.5`/`1.` are valid float literals in both languages; the `.` never goes
    // away without an exponent to keep the literal a float.
    expect(minifyShaderText('a(0.500, 1.0, 0.0, 1.0e-07, 100.0, 0.0001, 7u, 3, 0x1F);\n')).toBe(
      'a(.5,1.,0.,1e-7,1e2,1e-4,7u,3,0x1F);\n',
    )
    // The EXPONENT spelling wins wherever the fixed form pays for zeros — an
    // exact rewrite, since only the decimal point moves. It is refused at
    // exponent 0, where it would be both longer and an integer (`1e0` vs `1.`).
    expect(minifyShaderText('a(1000000.0, 0.000123, 1.5, 1.0);\n')).toBe('a(1e6,123e-6,1.5,1.);\n')
    // A full-precision f32 printout keeps every significand digit.
    expect(minifyShaderText('a(0.800000011920929);\n')).toBe('a(.800000011920929);\n')
    // …and the pass is opt-out for baseline diffing.
    expect(minifyShaderText('a(0.500, 1.0);\n', { numbers: false })).toBe('a(0.500,1.0);\n')
  })

  it("numbers: 'f32' re-spells to the shortest decimal with the SAME f32 bits", () => {
    // `0.800000011920929` IS `fround(0.8)` printed as f64 — `.8` is the same
    // number once the compiler rounds it, which it always does in f32 context.
    expect(
      minifyShaderText('a(0.800000011920929, 0.1000000014901161);\n', { numbers: 'f32' }),
    ).toBe('a(.8,.1);\n')
    // …and it shortens only as far as the f32 allows: 43758.5453 and 43758.547
    // are the same f32, 43758.55 is not.
    expect(minifyShaderText('a(43758.5453);\n', { numbers: 'f32' })).toBe('a(43758.547);\n')
    expect(Math.fround(43758.547)).toBe(Math.fround(43758.5453))
    expect(Math.fround(43758.55)).not.toBe(Math.fround(43758.5453))
    // A float whose shortest spelling is a whole number stays a FLOAT: `1` is
    // an abstract integer in WGSL and does not resolve against an f32 operator.
    expect(minifyShaderText('a(1.0, 2.00, 3.0e0);\n', { numbers: 'f32' })).toBe('a(1.,2.,3.);\n')
    // The default stays lossless — no f32 assumption unless asked.
    expect(minifyShaderText('a(0.800000011920929);\n')).toBe('a(.800000011920929);\n')
  })

  it("numbers: 'f32' stands down for a shader that mentions f16", () => {
    // The f32 claim is about the CONTEXT a literal lands in. An f16 anywhere
    // means that context might not be f32, so the mode degrades to lossless
    // rather than reason about which literal is which.
    const src = 'enable f16;\nfn f(x: f16) -> f16 { return 0.800000011920929; }\n'
    expect(minifyShaderText(src, { numbers: 'f32' })).toBe(minifyShaderText(src))
    expect(minifyShaderText(src, { numbers: 'f32' })).toContain('.800000011920929')
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

describe('emit-prod plugins through the { plugins } seam — integrated', () => {
  it('WGSL minify() plugin makes a single line (no directives) and shrinks', () => {
    const plain = emitModule(m)
    const min = emitModule(m, { plugins: [minify()] })
    expect(min.trimEnd().split('\n')).toHaveLength(1)
    expect(min.length).toBeLessThan(plain.length)
    expect(min).toContain('@vertex fn vs_min') // tokens intact, whitespace gone
  })

  it('GLSL keeps #version as line one; body is compacted; default emit is untouched', () => {
    const min = emitGlslModule(m, 'fragment', { plugins: [minify()] })
    expect(min.startsWith('#version 300 es\n')).toBe(true)
    expect(min.trimEnd().split('\n')).toHaveLength(2) // directive + one body line
    expect(min).toContain('precision highp float;')
    expect(emitGlslModule(m, 'fragment')).toContain('\n  ') // plain emit still indented
  })

  it('obfuscate() preset = [mangle, minify]: compacted, vocabulary gone, ABI intact', () => {
    const renames = new Map<string, string>()
    const wgsl = emitModule(m, { plugins: obfuscate({ renames }) })
    expect(wgsl.trimEnd().split('\n')).toHaveLength(1)
    expect(wgsl).not.toContain('MinVsOut') // plain struct mangled…
    expect(wgsl).toContain('fn vs_min') // …entry names intact
    expect(renames.get('MinVsOut')).toMatch(/^[a-zA-Z]{1,2}$/)
  })

  it('plugin composition is order-sensitive on the text stage and staged across stages', () => {
    // Two text plugins compose in array order; the IR-stage plugin (mangle)
    // always runs before either, regardless of array position.
    const upper = { name: 'upper', transformText: (c: string) => c }
    const a = emitModule(m, { plugins: [mangle(), minify(), upper] })
    const b = emitModule(m, { plugins: [upper, minify(), mangle()] })
    expect(a).toBe(b) // mangle staged before all transformText; upper is identity here
    expect(a.trimEnd().split('\n')).toHaveLength(1)
  })
})
