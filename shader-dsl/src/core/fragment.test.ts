// ═══ emitGlslFragment / emitFragment — the header comes back as DATA (#1711) ═══
//
// The arms that matter are the two the consumer's regex got wrong, and they pull in
// opposite directions — which is the whole reason a regex cannot do this job:
//
//   • no `#extension`  → `/^#version[^\n]*\n(?:precision[^\n]*\n)*/` eats the precision
//     lines, including the integer-sampler one the backend derives (#1703).
//   • an `#extension`  → the same regex matches only the `#version` line, because
//     `#extension` sits between it and the precision block, so the include keeps a
//     duplicate copy of every one of them.
//
// Both are pinned below AGAINST the regex, not just against the new API: each asserts
// what the old strip would have produced, so a future change that makes the header
// regex-shaped again fails here rather than in someone's pixel suite.

import { describe, it, expect } from 'vitest'
import {
  fn,
  module,
  textureLoad,
  toF32,
  vec2i,
  vec4,
  vec4fT,
  f32T,
  texture2duT,
  externFn,
} from './ir'
import { resource } from './sot'
import { emitGlslFragment, emitGlslModule } from './backends/glsl'
import { emitFragment, emitModule } from './backends/wgsl'

/** The strip the consumer had to write, reproduced verbatim as the decoy. */
const LEGACY_STRIP = /^#version[^\n]*\n(?:precision[^\n]*\n)*/

const shade = fn('shade', { x: f32T }, (p) => p.x.mul(0.5).add(0.5))
const fsEntry = fn(
  'fs_main',
  {},
  () => {
    const s = shade({ x: 0.25 })
    return vec4(s, s, s, 1.0)
  },
  { stage: 'fragment', retAttr: '@location(0)' },
)
const plain = module({ funcs: [shade, fsEntry] })

// An INTEGER texture, so the backend derives `precision highp usampler2D;` — the exact
// line #1703 added and the regex threw away.
const uTex = resource('u_data', texture2duT, { group: 0, binding: 0 })
const fsInt = fn(
  'fs_int',
  {},
  () => vec4(toF32(textureLoad(uTex.node, vec2i(0, 0), 0).x), 0.0, 0.0, 1.0),
  { stage: 'fragment', retAttr: '@location(0)' },
)
const withIntTexture = module({ funcs: [fsInt], uses: [uTex] })

describe('emitGlslFragment — the preamble is data, not a prefix to strip', () => {
  it('the source carries no #version and no precision line; the preamble carries both', () => {
    const f = emitGlslFragment(plain, 'fragment')
    expect(f.source).not.toContain('#version')
    expect(f.source).not.toContain('precision ')
    expect(f.preamble[0]).toBe('#version 300 es')
    expect(f.preamble).toContain('precision highp float;')
    expect(f.preamble).toContain('precision highp int;')
  })

  it('an integer texture keeps its sampler precision (#1703) — the regex dropped it', () => {
    const f = emitGlslFragment(withIntTexture, 'fragment')
    expect(f.preamble).toContain('precision highp usampler2D;')
    // The decoy: what the legacy strip would have produced from the whole-module emit.
    const stripped = emitGlslModule(withIntTexture, 'fragment').replace(LEGACY_STRIP, '')
    expect(stripped).not.toContain('usampler2D;')
  })

  it('preamble + source reproduces the whole-module emit BYTE for byte', () => {
    // The strongest statement the split can make: nothing was invented and nothing lost.
    for (const m of [plain, withIntTexture]) {
      const f = emitGlslFragment(m, 'fragment', { entryPoints: true })
      expect([...f.preamble, '', f.source].join('\n')).toBe(emitGlslModule(m, 'fragment'))
    }
  })

  it('entry points are excluded by default but still reported', () => {
    const f = emitGlslFragment(plain, 'fragment')
    expect(f.source).not.toContain('void main()')
    expect(f.declares.entryPoints).toEqual(['fs_main'])
    expect(f.declares.functions).toContain('shade')
    // …and opting in brings them back.
    expect(emitGlslFragment(plain, 'fragment', { entryPoints: true }).source).toContain(
      'void main()',
    )
  })

  it('declares names the bindings the fragment brings', () => {
    expect(emitGlslFragment(withIntTexture, 'fragment').declares.bindings).toEqual(['u_data'])
  })
})

describe('emitGlslFragment — #extension is the case the regex fails the OTHER way', () => {
  // `multiview` is GLSL's one source-directive capability (GLSL_CAP_PROFILE), so this is
  // the module shape where `#extension` sits between `#version` and the precision lines.
  const directed = module({ funcs: [shade, fsEntry], enables: ['multiview'] })

  it('the directive is in the preamble, not left inside the fragment source', () => {
    const f = emitGlslFragment(directed, 'fragment')
    expect(f.preamble).toContain('#extension GL_OVR_multiview2 : require')
    expect(f.source).not.toContain('#extension')
    expect(f.source).not.toContain('precision ')
  })

  it('the legacy strip would have LEFT the whole block behind — proving the bug', () => {
    const stripped = emitGlslModule(directed, 'fragment').replace(LEGACY_STRIP, '')
    expect(stripped).toContain('#extension GL_OVR_multiview2 : require')
    expect(stripped).toContain('precision highp float;')
  })

  it('the byte-identity round trip still holds with a directive present', () => {
    const f = emitGlslFragment(directed, 'fragment', { entryPoints: true })
    expect([...f.preamble, '', f.source].join('\n')).toBe(emitGlslModule(directed, 'fragment'))
  })
})

describe('fragment.requires — host-provided symbols, and only those', () => {
  const hostFn = externFn('host_tone_map', { c: vec4fT }, vec4fT)
  const usesHost = fn('apply_tone', { c: vec4fT }, (p) => hostFn({ c: p.c }))
  const m = module({
    funcs: [
      usesHost,
      fn('fs_host', {}, () => usesHost({ c: vec4(1.0, 0.0, 0.0, 1.0) }), {
        stage: 'fragment',
        retAttr: '@location(0)',
      }),
    ],
  })

  it('names the extern, and NOT the module fn or the intrinsics it calls', () => {
    const f = emitGlslFragment(m, 'fragment')
    expect(f.requires).toEqual(['host_tone_map'])
    expect(f.requires).not.toContain('apply_tone')
  })

  it('a module with no externs requires nothing', () => {
    // Non-vacuity for the arm above: `requires` is not simply "every call name".
    expect(emitGlslFragment(plain, 'fragment').requires).toEqual([])
  })
})

describe('emitFragment (WGSL)', () => {
  it('excludes entries, reports them, and needs no header split', () => {
    const f = emitFragment(plain)
    expect(f.source).not.toContain('@fragment')
    expect(f.declares.entryPoints).toEqual(['fs_main'])
    expect(f.preamble).toEqual([])
    expect(emitFragment(plain, { entryPoints: true }).source).toContain('@fragment')
  })

  it('an enable directive lands in the preamble, not the source', () => {
    const directed = module({ funcs: [shade, fsEntry], enables: ['f16'] })
    const f = emitFragment(directed, { entryPoints: true })
    expect(f.preamble).toEqual(['enable f16;'])
    expect(f.source).not.toContain('enable f16;')
    // Round trip: the driver puts a blank line between directives and declarations.
    expect(`${f.preamble.join('\n')}\n\n${f.source}`).toBe(emitModule(directed))
  })
})
