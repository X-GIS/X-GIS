// ═══ hostBlock (#1710) — the host owns a whole BLOCK, not just single values ═══
//
// `hostUniform` covers one host-provided value. This is the other half of the issue's
// proposal, and the half that cannot be built out of the first one: on WGSL a host-owned
// bind group is ONE unit. MapLibre (or any host renderer) hands us `@group(0)` and its
// layout is the authority — decomposing that into N scalar declarations describes a
// different program, and is exactly the rewrite-every-seam migration the issue says a
// WebGPU switch must not become.
//
// On GLSL the block has two spellings and the consumer's prelude decides which one links,
// so the spelling is an input rather than a fact:
//
//   'std140-block'  layout(std140) uniform CameraUniforms { … } u_camera;   (default)
//   'loose'         uniform mat4 u_matrix;  …  and `u_camera.u_matrix` → `u_matrix`
//
// The consumer's workaround was
//
//     lowered = lowered.replaceAll(`${block.name}.${field.name}`, field.name)
//
// — a text substitution over generated source. Doing the same job by matching
// `member(varref(block), field)` on the IR is better in three ways, and only two of them
// are demonstrated here, deliberately:
//
//   DEMONSTRATED  it survives `minify()`, which collapses the whitespace the consumer's
//                 line-by-line block parse depends on, and `mangle()`, which renames the
//                 block variable the text pattern is keyed on. Those two arms are real and
//                 are why that consumer could not use production emit at all.
//   DEMONSTRATED  `reflect()` still describes what was emitted, because the flattening
//                 produced real BindingDecls rather than edited text.
//   NOT CLAIMED   that `replaceAll` corrupts a similarly-named identifier. It is an
//                 unbounded substitution and that is a real hazard, but every corruption
//                 this file tried to construct turned out benign, so no arm asserts one.
//                 The decoy below pins the narrower true thing: the rewrite touches member
//                 reads of the block and nothing else.

import { describe, it, expect } from 'vitest'
import { Let, fn, module, transformMat4, vec4, vec2fT, vec4fT, f32T, mat4x4fT, structT } from './ir'
import { builtin, hostBlock, hostUniform, ioStruct, uniformStruct } from './sot'
import { emitGlslModule } from './backends/glsl'
import { emitModule } from './backends/wgsl'
import { minify } from '../emit-prod'
import { mangleModule } from './passes/mangle'
import { reflect } from './reflect'

// GLSL links varyings by name, so a vertex entry returns an ioStruct rather than a bare vec4.
const VsOut = ioStruct('HostVsOut', { pos: builtin('position', vec4fT) })

/** The fixture: MapLibre's own shape — an MVP transform against host-provided globals.
 *
 *  Every member is READ. That is not decoration: a binding no reachable fn references is
 *  dropped from the stage's declarations, so an unread member would make the arms below
 *  pass on a lowering that emitted nothing at all.
 *
 *  `u_fade_scaled` is a DECOY, and load-bearing — a local whose name has a member name as a
 *  strict prefix. It exists so a text-level rewrite keyed on member names has something to
 *  damage, and the IR-level one has something to leave alone. */
function mod(glsl: 'std140-block' | 'loose') {
  const cam = hostBlock(
    'CameraUniforms',
    { group: 0, binding: 0, as: 'u_camera' },
    { u_matrix: mat4x4fT, u_viewport: vec2fT, u_fade: f32T },
    { glsl, precision: 'highp' },
  )
  const entry = fn(
    'vs_host',
    {},
    () => {
      const scaled = Let('u_fade_scaled', cam.field.u_fade.mul(2.0))
      return VsOut.construct({
        pos: transformMat4(
          cam.field.u_matrix,
          vec4(cam.field.u_viewport.x, cam.field.u_viewport.y, scaled, 1.0),
        ),
      })
    },
    { stage: 'vertex' },
  )
  return { cam, m: module({ uses: [VsOut, cam], funcs: [entry] }) }
}

describe('hostBlock — WGSL keeps the block, because a host bind group is one unit', () => {
  it('emits an ordinary uniform block declaration, whatever the GLSL spelling says', () => {
    for (const glsl of ['std140-block', 'loose'] as const) {
      const src = emitModule(mod(glsl).m)
      expect(src).toMatch(/@group\(0\)\s*@binding\(0\)\s*var<uniform>\s*u_camera\s*:/)
      expect(src).toContain('struct CameraUniforms')
      expect(src).toContain('u_camera.u_viewport') // reads stay qualified
    }
  })

  it('is byte-identical on WGSL across the two GLSL spellings', () => {
    // The strongest statement that `glsl` is GLSL-only: if it ever leaks into the WGSL path
    // this goes red, instead of a reviewer having to notice a subtle difference.
    expect(emitModule(mod('loose').m)).toBe(emitModule(mod('std140-block').m))
  })
})

describe("hostBlock — GLSL 'std140-block' is the default, and is the old behaviour", () => {
  it('emits the std140 block, with qualified reads', () => {
    const src = emitGlslModule(mod('std140-block').m, 'vertex')
    expect(src).toMatch(/layout\(std140\)\s*uniform\s+CameraUniforms/)
    expect(src).toContain('u_camera.u_viewport')
  })

  it('defaults to the block, and to host ownership', () => {
    const cam = hostBlock('C', { group: 0, binding: 0, as: 'u_c' }, { a: f32T })
    expect(cam.binding.glsl).toBe('std140-block')
    expect(cam.binding.owner).toBe('host')
  })

  it('emits identically to the module-owned block it mirrors', () => {
    // A host-owned std140 block differs from a module-owned one only in the REFLECTION.
    // If ownership ever changed the emitted bytes, a consumer flipping `owner` to describe
    // reality would silently change the program.
    const own = uniformStruct(
      'CameraUniforms',
      { group: 0, binding: 0, as: 'u_camera' },
      {
        u_matrix: mat4x4fT,
        u_viewport: vec2fT,
        u_fade: f32T,
      },
    )
    const entry = fn(
      'vs_host',
      {},
      () => {
        const scaled = Let('u_fade_scaled', own.field.u_fade.mul(2.0))
        return VsOut.construct({
          pos: transformMat4(
            own.field.u_matrix,
            vec4(own.field.u_viewport.x, own.field.u_viewport.y, scaled, 1.0),
          ),
        })
      },
      { stage: 'vertex' },
    )
    const moduleOwned = module({ uses: [VsOut, own], funcs: [entry] })
    expect(emitGlslModule(mod('std140-block').m, 'vertex')).toBe(
      emitGlslModule(moduleOwned, 'vertex'),
    )
  })
})

describe("hostBlock — GLSL 'loose' flattens the block, on the IR", () => {
  const src = emitGlslModule(mod('loose').m, 'vertex')

  it('emits one default-block uniform per member, with the declared precision', () => {
    expect(src).toMatch(/uniform\s+highp\s+mat4\s+u_matrix\s*;/)
    expect(src).toMatch(/uniform\s+highp\s+vec2\s+u_viewport\s*;/)
    expect(src).toMatch(/uniform\s+highp\s+float\s+u_fade\s*;/)
  })

  it('emits NO std140 block and NO orphaned struct for it', () => {
    expect(src).not.toContain('layout(std140)')
    expect(src).not.toContain('struct CameraUniforms')
  })

  it('rewrites every member read to the bare name', () => {
    expect(src).not.toContain('u_camera')
    expect(src).toContain('u_viewport')
  })

  it('rewrites member reads of the block and nothing else', () => {
    // `u_fade_scaled` is a local whose name has the member `u_fade` as a strict prefix. It
    // must survive intact and must NOT become a uniform: the rewrite is keyed on the
    // `member(varref(u_camera), …)` node, not on the identifier text.
    expect(src).toMatch(/\bu_fade_scaled\b/)
    expect(src).not.toMatch(/uniform[^;\n]*u_fade_scaled\s*;/)
    expect(src).not.toMatch(/_scaled_scaled|u_camera\./)
  })
})

describe('hostBlock — the properties the string surgery could not have', () => {
  it('survives minify(), which the line-based lowering could not', () => {
    // The consumer's `lowerLooseUniformBlock` parses the block LINE BY LINE, so a
    // whitespace-collapsing text plugin destroys it — that consumer could not use
    // production emit at all. Here the flattening happened on the IR, long before text.
    const out = emitGlslModule(mod('loose').m, 'vertex', { plugins: [minify()] })
    expect(out).toContain('u_matrix')
    expect(out).not.toContain('u_camera')
  })

  it('survives mangle() — a host-owned name is never renamed', () => {
    const mangled = mangleModule(mod('loose').m).module
    const out = emitGlslModule(mangled, 'vertex')
    for (const name of ['u_matrix', 'u_viewport', 'u_fade'])
      expect(out).toMatch(new RegExp(`uniform\\s+highp\\s+\\w+\\s+${name}\\s*;`))
  })

  it('reflect() reports ownership AND the spelling a host needs in order to bind', () => {
    const r = reflect(mod('loose').m)
    const entry = r.bindGroups[0]!.entries[0]!
    expect(entry.owner).toBe('host')
    expect(entry.glslSpelling).toBe('loose')
    expect(entry.structName).toBe('CameraUniforms')
    // The member list survives in declaration order — it is what a loose binder needs, since
    // each member is set individually by NAME.
    expect(r.uniforms[0]!.fields.map((f) => f.name)).toEqual(['u_matrix', 'u_viewport', 'u_fade'])
  })

  it('reports no spelling at all for a MODULE-owned block', () => {
    // Otherwise `glslSpelling` would read as a choice where none exists, and a consumer
    // could branch on what is really just a default.
    const own = uniformStruct('C', { group: 0, binding: 0, as: 'u_c' }, { a: f32T })
    const m = module({
      uses: [VsOut, own],
      funcs: [
        fn('vs', {}, () => VsOut.construct({ pos: vec4(own.field.a, 0.0, 0.0, 1.0) }), {
          stage: 'vertex',
        }),
      ],
    })
    expect(reflect(m).bindGroups[0]!.entries[0]!.glslSpelling).toBeUndefined()
    expect(reflect(mod('std140-block').m).bindGroups[0]!.entries[0]!.glslSpelling).toBe(
      'std140-block',
    )
  })
})

describe('hostBlock — shapes it refuses, and the ones it must not', () => {
  it('refuses a loose member the default block cannot spell', () => {
    expect(() =>
      hostBlock(
        'C',
        { group: 0, binding: 0, as: 'u_c' },
        { inner: structT('Inner') },
        { glsl: 'loose' },
      ),
    ).toThrow(/cannot be a loose uniform/)
  })

  it('allows that same member in a std140 block, where GLSL can spell it', () => {
    // Without this arm the one above would pass on a declarator that refused everything.
    expect(() =>
      hostBlock('C', { group: 0, binding: 0, as: 'u_c' }, { inner: structT('Inner') }),
    ).not.toThrow()
  })

  it('refuses two loose blocks that would flatten to the same member name', () => {
    const a = hostBlock('A', { group: 0, binding: 0, as: 'u_a' }, { u_x: f32T }, { glsl: 'loose' })
    const b = hostBlock('B', { group: 0, binding: 1, as: 'u_b' }, { u_x: f32T }, { glsl: 'loose' })
    const m = module({
      uses: [VsOut, a, b],
      funcs: [
        fn('vs', {}, () => VsOut.construct({ pos: vec4(a.field.u_x, b.field.u_x, 0.0, 1.0) }), {
          stage: 'vertex',
        }),
      ],
    })
    // Caught at EMIT, not at declaration: neither block can know about the other until a
    // module carries both. The message names BOTH, because naming one sends the reader to
    // whichever half they did not just change.
    expect(() => emitGlslModule(m, 'vertex')).toThrow(/'u_a'[\s\S]*'u_b'|'u_b'[\s\S]*'u_a'/)
  })

  it('hostUniform points at hostBlock for a struct, instead of at overrideConst', () => {
    // Was SD0014, whose registered hint talks about specialization constants and tells the
    // reader to "decompose into per-component scalar overrides" — advice for a different
    // declarator entirely.
    expect(() => hostUniform('u_cam', structT('C'), { group: 0, binding: 0 })).toThrow(/hostBlock/)
  })
})
