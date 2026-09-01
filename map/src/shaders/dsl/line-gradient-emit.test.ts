// line-gradient (#2117) — the PROGRESS + SUBSTITUTION half of the shader.
//
// The load-bearing claim this file pins is NOT "a gradient block exists" — it is that
// `line-progress` is the SAME cumulative arc the dash phase already rides, divided by
// the polyline total the segment builder stamped. A second arc-length authority (a new
// per-vertex progress attribute, a re-derived arc) is exactly the failure class this
// repo has paid for, and it would look identical in a screenshot. So the assertion is
// SUB-EXPRESSION IDENTITY: the dash phase and the gradient progress must contain the
// byte-identical `arc_start + clamp(t_along, 0, seg_len)` term.
//
// Fail-before cuts, each naming ONE half:
//   • revert line.ts               → no `resolved_color` / no gradient_count guard here
//   • add a private progress lane  → the shared-arcPos assertion fails while the rest passes

import { describe, it, expect } from 'vitest'
import { emitLineWgsl } from './index'
import { emitLineGlsl } from './line-glsl'

/** Escape a literal for use inside a RegExp. */
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The local a hoist bound `<rhs>` to, e.g. `let _licm11 = layer.gradient_count;`. */
function aliasOf(src: string, rhs: string): string {
  const m = src.match(
    new RegExp(String.raw`(?:let|uint|float|vec4(?:\[\d+\])?)\s+(\w+)\s*=\s*${esc(rhs)};`),
  )
  expect(m, `no hoist found for ${rhs}`).not.toBeNull()
  return m![1]!
}

/**
 * @param arcStart    the local holding LineSegment.arc_start
 * @param lineLength  the local holding LineSegment.line_length
 * @param u32Suffix   'u' on both backends (WGSL `0u`, GLSL `0u`)
 */
function assertOneArcAuthority(
  src: string,
  arcStart: string,
  lineLength: string,
  u32Suffix: string,
) {
  const gradCount = aliasOf(src, 'layer.gradient_count')

  // 1. The ramp is GATED — a layer with no gradient pays a single u32 compare.
  expect(src).toContain(`(${gradCount} > 0${u32Suffix})`)

  // 2. The ramp REPLACES the resolved solid colour, and base_color reads the result —
  //    so a gradient layer cannot also paint its solid stroke underneath.
  expect(src).toMatch(/resolved_color/)
  expect(src).toContain('base_color = resolved_color')

  // 3. The divisor is line_length, guarded against a degenerate zero-length polyline.
  const norm = src.match(new RegExp(String.raw`(\w+)\s*=\s*max\(${esc(lineLength)}, 0\.000001\);`))
  expect(norm, 'progress is not normalised by max(line_length, eps)').not.toBeNull()
  const total = norm![1]!

  // 4. THE claim: the numerator is byte-identically the term the DASH phase uses —
  //    `arc_start + clamp(t_along, 0, seg_len)`.
  const arcM = src.match(new RegExp(String.raw`\(${esc(arcStart)} \+ clamp\(\w+, 0\.0, \w+\)\)`))
  expect(arcM, 'no arc_start + clamp(t_along, …) term in the shader').not.toBeNull()
  const arcPos = arcM![0]!
  expect(src, 'gradient progress is not arcPos / line_length').toContain(
    `clamp((${arcPos} / ${total}), 0.0, 1.0)`,
  )

  // 5. …and that same arcPos really is the dash / pattern arms' input, not a lookalike:
  //    it must appear well outside the two gradient uses, which is only true when both
  //    subsystems read ONE authority.
  const occurrences = src.split(arcPos).length - 1
  expect(occurrences, 'arcPos is not shared with the dash / pattern arms').toBeGreaterThan(2)
}

describe('emitLineWgsl / emitLineGlsl — line-gradient rides the dash arc', () => {
  for (const pick of [false, true]) {
    it(`WGSL: progress = arc_start + t_along over line_length (pick=${pick})`, () => {
      const wgsl = emitLineWgsl(null, pick)
      expect(wgsl).toContain('gradient_count: u32')
      expect(wgsl).toContain('gradient_color: array<vec4<f32>, 8>')
      expect(wgsl).toContain('gradient_pos: array<vec4<f32>, 2>')
      assertOneArcAuthority(
        wgsl,
        aliasOf(wgsl, 'segments[input.seg_id].arc_start'),
        aliasOf(wgsl, 'segments[input.seg_id].line_length'),
        'u',
      )
    })
  }

  it('GLSL (WebGL2): the same ramp lane over the same emulated-segment slots', () => {
    // The segments storage buffer lowers to an R32F data texture here, so arc_start /
    // line_length are stride slots 12 / 13 — pinning the SLOT is a stronger statement of
    // "same authority" than pinning a field name would be.
    const glsl = emitLineGlsl(null, false, 'fragment')
    expect(glsl).toContain('uint gradient_count;')
    expect(glsl).toContain('vec4[8] gradient_color;')
    expect(glsl).toContain('vec4[2] gradient_pos;')
    const base = glsl.match(/_sfetch\(segments, int\(\((\w+) \+ 12u\)\)\)/)
    expect(base, 'no segments[…+12] (arc_start) fetch in the GLSL fragment').not.toBeNull()
    assertOneArcAuthority(
      glsl,
      aliasOf(glsl, `_sfetch(segments, int((${base![1]} + 12u)))`),
      aliasOf(glsl, `_sfetch(segments, int((${base![1]} + 13u)))`),
      'u',
    )
  })

  it('no ramp texture / sampler was added to the line pipeline', () => {
    // The ramp deliberately rides the LAYER UNIFORM, not a new binding: group(1)'s bind
    // group is built once per tile SEGMENT BUFFER (line-renderer.ts createLayerBindGroup)
    // while the per-layer style rides a dynamic offset, so a per-layer ramp texture would
    // need a bind group per (tile × layer). If someone adds one, this fails loudly.
    const wgsl = emitLineWgsl(null, false)
    const textures = wgsl.match(/:\s*(texture_2d<f32>|sampler)\s*;/g) ?? []
    expect(textures.length, `line shader texture bindings: ${textures.join(', ')}`).toBe(2)
  })
})
