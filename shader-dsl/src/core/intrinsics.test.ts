import { describe, it, expect } from 'vitest'
import { spellIntrinsic } from './intrinsics'

// #3a — the neutral registry is the spelling SoT; each backend maps the same
// neutral id to its own spelling (the WGSL string is no longer the canonical id).
describe('intrinsics — neutral registry (#3a)', () => {
  it('atan2: atan2 on wgsl, atan on glsl', () => {
    expect(spellIntrinsic('wgsl', 'atan2', ['y', 'x'])).toBe('atan2(y, x)')
    expect(spellIntrinsic('glsl', 'atan2', ['y', 'x'])).toBe('atan(y, x)')
  })

  it('bitcastU32: bitcast<u32> on wgsl, floatBitsToUint on glsl (no WGSL syntax in the id)', () => {
    expect(spellIntrinsic('wgsl', 'bitcastU32', ['f'])).toBe('bitcast<u32>(f)')
    expect(spellIntrinsic('glsl', 'bitcastU32', ['f'])).toBe('floatBitsToUint(f)')
  })

  it('scalar conversions: f32/i32/u32 cast on wgsl, float/int/uint on glsl', () => {
    expect(spellIntrinsic('wgsl', 'f32', ['x'])).toBe('f32(x)')
    expect(spellIntrinsic('glsl', 'f32', ['x'])).toBe('float(x)')
    expect(spellIntrinsic('wgsl', 'i32', ['x'])).toBe('i32(x)')
    expect(spellIntrinsic('glsl', 'i32', ['x'])).toBe('int(x)')
    expect(spellIntrinsic('wgsl', 'u32', ['x'])).toBe('u32(x)')
    expect(spellIntrinsic('glsl', 'u32', ['x'])).toBe('uint(x)')
  })

  it('select: WGSL select(f,t,c) vs GLSL ternary', () => {
    expect(spellIntrinsic('wgsl', 'select', ['F', 'T', 'C'])).toBe('select(F, T, C)')
    expect(spellIntrinsic('glsl', 'select', ['F', 'T', 'C'])).toBe('(C ? T : F)')
  })

  it('textureSample drops the sampler arg on glsl', () => {
    expect(spellIntrinsic('wgsl', 'textureSample', ['t', 's', 'uv'])).toBe(
      'textureSample(t, s, uv)',
    )
    expect(spellIntrinsic('glsl', 'textureSample', ['t', 's', 'uv'])).toBe('texture(t, uv)')
  })

  it('a non-registry name passes through identically (portable builtin / user fn)', () => {
    expect(spellIntrinsic('wgsl', 'sin', ['x'])).toBe('sin(x)')
    expect(spellIntrinsic('glsl', 'proj_mercator', ['a', 'b'])).toBe('proj_mercator(a, b)')
  })

  // GLSL texelFetch/textureSize REQUIRE an `int` lod; WGSL textureLoad passes a u32
  // level and textureDimensions(t) omits it. The glsl spelling supplies/casts to int;
  // the wgsl spelling stays untouched (WGSL byte-identity).
  it('textureLoad: WGSL unchanged; GLSL texelFetch wraps the lod in int()', () => {
    expect(spellIntrinsic('wgsl', 'textureLoad', ['t', 'c', 'lvl'])).toBe('textureLoad(t, c, lvl)')
    expect(spellIntrinsic('glsl', 'textureLoad', ['t', 'c', 'lvl'])).toBe(
      'texelFetch(t, c, int(lvl))',
    )
  })

  it('textureDimensions: WGSL unchanged; GLSL textureSize (int lod) wrapped in uvec2', () => {
    expect(spellIntrinsic('wgsl', 'textureDimensions', ['t'])).toBe('textureDimensions(t)')
    // GLSL textureSize returns a SIGNED ivec2; wrap in uvec2 so the type matches the
    // IR's vec2<u32> (else the optimizer's CSE hoist `uvec2 _cse = textureSize(…)` is a
    // GLSL int/uint compile error). 0 lod when absent.
    expect(spellIntrinsic('glsl', 'textureDimensions', ['t'])).toBe('uvec2(textureSize(t, 0))')
    // explicit level form casts the given level to int.
    expect(spellIntrinsic('glsl', 'textureDimensions', ['t', 'lvl'])).toBe(
      'uvec2(textureSize(t, int(lvl)))',
    )
  })
})
