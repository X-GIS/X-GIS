import { describe, it, expect } from 'vitest'
import { ShaderDslError, dslError, formatLoc } from './error'
import { ValidationError } from '../passes/validate'
import { UnsupportedFeatureError } from '../backend'

describe('dslError / ShaderDslError', () => {
  it('composes a coded message with the catalogue summary', () => {
    const e = dslError('SD0002', 'add: vec3<f32> vs vec2<f32>')
    expect(e).toBeInstanceOf(ShaderDslError)
    expect(e.code).toBe('SD0002')
    expect(e.message).toContain('shader-dsl [SD0002]:')
    expect(e.message).toContain('binary op on mismatched vectors')
    expect(e.message).toContain('add: vec3<f32> vs vec2<f32>')
  })

  it('appends an indented hint line', () => {
    const e = dslError('SD0005', '<<, got f32')
    expect(e.message).toMatch(/\n {2}hint: /)
    expect(e.hint).toBeDefined()
  })

  it('appends an at-location line when a loc is supplied', () => {
    const loc = { file: '/x/shader.ts', line: 12, col: 3 }
    const e = dslError('SD0001', 'mul: mat4 * vec3', { loc })
    expect(e.loc).toEqual(loc)
    expect(e.message).toContain(`at ${formatLoc(loc)}`)
    expect(formatLoc(loc)).toBe('/x/shader.ts:12:3')
  })
})

describe('error subclasses preserve identity', () => {
  it('ValidationError is a ShaderDslError and keeps its name + diagnostics', () => {
    const diags = [{ ruleId: 'r', severity: 'error' as const, message: 'm', code: 'SD0020' }]
    const e = new ValidationError(diags)
    expect(e).toBeInstanceOf(ShaderDslError)
    expect(e).toBeInstanceOf(ValidationError)
    expect(e.name).toBe('ValidationError')
    expect(e.code).toBe('SD0020')
    expect(e.diagnostics).toBe(diags)
  })

  it('UnsupportedFeatureError is a ShaderDslError carrying SD0030, message verbatim', () => {
    const e = new UnsupportedFeatureError('glsl-es300: storage buffer (SSBO) — fail-closed')
    expect(e).toBeInstanceOf(ShaderDslError)
    expect(e).toBeInstanceOf(UnsupportedFeatureError)
    expect(e.name).toBe('UnsupportedFeatureError')
    expect(e.code).toBe('SD0030')
    expect(e.message).toBe('glsl-es300: storage buffer (SSBO) — fail-closed')
  })
})
