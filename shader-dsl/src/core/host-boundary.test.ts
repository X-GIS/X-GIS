// ═══ externVar (#1713) + hostUniform (#1710) — the host boundary, declared ═══
//
// These are one concept at two granularities, which is why they are one design and one
// test file. The dc4i corpus on #1710 proves it: its four helpers run as a single chain —
// strip the header, cut the std140 block open into loose uniforms, put back the precision
// the strip destroyed, splice the host's #includes. Steps 1/3/4 are #1711; step 2 is
// #1710; and the reason step 3 exists at all is that step 1 broke what step 2 needs.
//
//   hostUniform  — WE declare it, the HOST owns the resource. GLSL: a loose default-block
//                  uniform (what a prelude actually provides). WGSL: a normal binding,
//                  marked `owner: 'host'` so the host's layout is the authority.
//   externVar    — the HOST declares it. Emits nothing at all; we only reference it.
//
// The acceptance arm at the bottom is the one that matters: the emitted result matches
// what the string surgery produced, AND survives `minify()`, which the surgery could not.

import { describe, it, expect } from 'vitest'
import { externVar, fn, module, transformMat4, vec4, vec2fT, vec4fT, f32T, mat4x4fT } from './ir'
import { builtin, hostUniform, ioStruct, resource, uniformStruct } from './sot'
import { emitGlslFragment, emitGlslModule } from './backends/glsl'
import { emitModule } from './backends/wgsl'
import { minify } from '../emit-prod'
import { mangleModule } from './passes/mangle'
import { reflect } from './reflect'

// ── externVar ────────────────────────────────────────────────────────────────

describe('externVar — the host declares it; we only reference it', () => {
  // A vec4, for the arms that only need SOME extern to reference. The mat4 `u_matrix` a real
  // host prelude provides gets its own arm below, because it is the case every consumer hits
  // first and a fixture that never spells it proves nothing about it.
  const uCamera = externVar('u_camera_pos', vec4fT, { stage: 'vertex' })
  // GLSL links varyings by name, so a vertex entry returns an ioStruct rather than a bare
  // vec4 — the backend rejects the bare form outright.
  const VsOut = ioStruct('HostVsOut', { pos: builtin('position', vec4fT) })
  const m = module({
    externs: [uCamera.decl],
    uses: [VsOut],
    funcs: [
      fn('vs_host', {}, () => VsOut.construct({ pos: uCamera.node.mul(2.0) }), {
        stage: 'vertex',
      }),
    ],
  })

  it('emits NO declaration on either backend, but does emit the reference', () => {
    const g = emitGlslModule(m, 'vertex')
    const w = emitModule(m)
    for (const src of [g, w]) {
      expect(src).toContain('u_camera_pos')
      expect(src).not.toMatch(/uniform[^;\n]*u_camera_pos\s*;/)
      expect(src).not.toMatch(/var[^;\n]*u_camera_pos\s*:/)
    }
  })

  it('reflect().requires reports it, with its type and per-target spellings', () => {
    const withMatrix = module({
      externs: [externVar('u_matrix', mat4x4fT, { stage: 'vertex' }).decl],
      uses: [VsOut],
      funcs: [
        fn('vs_m0', {}, () => VsOut.construct({ pos: vec4(0, 0, 0, 1) }), { stage: 'vertex' }),
      ],
    })
    expect(reflect(withMatrix).requires).toEqual([
      {
        name: 'u_matrix',
        type: 'mat4x4<f32>',
        wgsl: 'u_matrix',
        glsl: 'u_matrix',
        stage: 'vertex',
      },
    ])
  })

  it('a mat4 extern transforms a position — the case every host prelude starts with', () => {
    // `u_matrix * a_pos` is the FIRST thing a MapLibre-shaped consumer writes, and until now
    // no arm here spelled it: the fixture above uses a vec4, so the mat4 was only ever
    // exercised through `reflect()`, which needs the declaration and not the product. A
    // declarator whose headline use is untested is the shape §12 records from #1703.
    //
    // The generic `.mul` REJECTS mat x vec deliberately (`ir/node.ts:1860`) — the MVP
    // transform gets a name at the call site instead of disappearing into an operator — so
    // the spelling is `transformMat4`, not an operator gap.
    const uMatrix = externVar('u_matrix', mat4x4fT, { stage: 'vertex' })
    const mm = module({
      externs: [uMatrix.decl],
      uses: [VsOut],
      funcs: [
        fn(
          'vs_mvp',
          {},
          () => VsOut.construct({ pos: transformMat4(uMatrix.node, vec4(1, 2, 3, 1)) }),
          {
            stage: 'vertex',
          },
        ),
      ],
    })
    // The product is emitted, and the host's symbol is still never DECLARED by us.
    const g = emitGlslModule(mm, 'vertex')
    expect(g).toContain('u_matrix * vec4(1.0, 2.0, 3.0, 1.0)')
    expect(g).not.toMatch(/uniform[^;\n]*u_matrix\s*;/)
    expect(emitModule(mm)).toContain('u_matrix * vec4<f32>(1.0, 2.0, 3.0, 1.0)')
  })

  it('a fragment lists it under requires, next to the extern FUNCTIONS', () => {
    expect(emitGlslFragment(m, 'vertex', { entryPoints: true }).requires).toContain('u_camera_pos')
  })

  it('a per-target spelling map reaches the emit — the migration seam', () => {
    const delta = externVar('terrain_delta', f32T, {
      spelling: { glsl: 'terrain.terrain_delta', wgsl: 'host.terrain_delta' },
    })
    const sm = module({
      externs: [delta.decl],
      funcs: [
        fn('fs_t', {}, () => vec4(delta.node, 0.0, 0.0, 1.0), {
          stage: 'fragment',
          retAttr: '@location(0)',
        }),
      ],
    })
    expect(emitGlslModule(sm, 'fragment')).toContain('terrain.terrain_delta')
    expect(emitModule(sm)).toContain('host.terrain_delta')
    // …and neither target leaks the OTHER one's spelling.
    expect(emitGlslModule(sm, 'fragment')).not.toContain('host.terrain_delta')
    expect(emitModule(sm)).not.toContain('terrain.terrain_delta')
  })

  it('mangle never renames it — the host prelude spells it', () => {
    const helper = fn('local_helper', { x: f32T }, (p) => p.x.mul(2.0))
    const mm = module({
      externs: [uCamera.decl],
      uses: [VsOut],
      funcs: [
        helper,
        fn('vs_m', {}, () => VsOut.construct({ pos: uCamera.node.mul(helper({ x: 1.0 })) }), {
          stage: 'vertex',
        }),
      ],
    })
    const { module: mangled, renames } = mangleModule(mm)
    // Non-vacuity: mangle DID rename something, so "u_camera_pos survived" means something.
    expect(renames.get('local_helper')).toBeTruthy()
    expect(emitModule(mangled)).toContain('u_camera_pos')
    expect(emitModule(mangled)).not.toContain('local_helper')
  })
})

// ── hostUniform ──────────────────────────────────────────────────────────────

describe('hostUniform — we declare it, the host owns it', () => {
  const viewport = hostUniform(
    'u_viewport_px',
    vec2fT,
    { group: 0, binding: 1 },
    {
      precision: 'highp',
    },
  )
  const ours = uniformStruct('Ours', { group: 0, binding: 0, as: 'ours' }, { tint: vec4fT })
  const m = module({
    uses: [ours, viewport],
    funcs: [
      fn('fs_hv', {}, () => vec4(viewport.node.x, viewport.node.y, ours.field.tint.z, 1.0), {
        stage: 'fragment',
        retAttr: '@location(0)',
      }),
    ],
  })

  it('GLSL lowers it to a LOOSE uniform with its precision, not a std140 block', () => {
    const g = emitGlslModule(m, 'fragment')
    expect(g).toContain('uniform highp vec2 u_viewport_px;')
    expect(g).not.toContain('layout(std140) uniform Ours_viewport')
    // …while the module-owned binding beside it is still a block, so the two coexist.
    expect(g).toContain('layout(std140) uniform Ours {')
  })

  it('WGSL declares it normally — ownership is metadata, not a spelling change', () => {
    expect(emitModule(m)).toContain('@group(0) @binding(1) var<uniform> u_viewport_px: vec2<f32>;')
  })

  it('reflect() distinguishes host-owned from module-owned', () => {
    const byName = new Map(
      reflect(m)
        .bindGroups.flatMap((g) => g.entries)
        .map((e) => [e.name, e]),
    )
    expect(byName.get('u_viewport_px')?.owner).toBe('host')
    expect(byName.get('ours')?.owner).toBe('module')
  })

  it('a struct is rejected — a prelude declares members, not blocks', () => {
    expect(() =>
      hostUniform('u_block', { kind: 'struct', name: 'B', fields: [] }, { group: 0, binding: 2 }),
    ).toThrow(/hostUniform/)
  })

  it('without owner: host, a bare vec uniform is still the unchanged hard error', () => {
    // The loose lowering is a per-DECLARATION promotion, not a relaxation of the rule.
    const loose = resource('u_bare', vec2fT, { group: 0, binding: 3 })
    const bad = module({
      uses: [loose],
      funcs: [
        fn('fs_bare', {}, () => vec4(loose.node.x, 0.0, 0.0, 1.0), {
          stage: 'fragment',
          retAttr: '@location(0)',
        }),
      ],
    })
    expect(() => emitGlslModule(bad, 'fragment')).toThrow(/must be a struct/)
  })
})

// ── the dc4i corpus, as an acceptance test ───────────────────────────────────

describe('#1710 acceptance — the string surgery, replaced', () => {
  // What the consumer's `emitGlslHelperModuleWithLooseUniforms` + `ensureGlslUniformPrecision`
  // produced, now authored directly. Two host uniforms, a helper, no entry point: exactly
  // the shape of a MapLibre include.
  const scale = hostUniform('u_scale', f32T, { group: 0, binding: 0 }, { precision: 'highp' })
  const viewport = hostUniform(
    'u_viewport_px',
    vec2fT,
    { group: 0, binding: 1 },
    {
      precision: 'highp',
    },
  )
  const helper = fn('overlay_frame_factor', { t: f32T }, (p) =>
    p.t.mul(scale.node).div(viewport.node.x),
  )
  const include = module({ uses: [scale, viewport], funcs: [helper] })

  it('one declaration yields the loose GLSL the host prelude expects', () => {
    const f = emitGlslFragment(include)
    expect(f.source).toContain('uniform highp float u_scale;')
    expect(f.source).toContain('uniform highp vec2 u_viewport_px;')
    expect(f.source).toContain('float overlay_frame_factor(')
    // No header to strip, and no block to cut open.
    expect(f.source).not.toContain('#version')
    expect(f.source).not.toContain('layout(std140)')
    // Field references are direct — no `block.field` to text-replace.
    expect(f.source).not.toMatch(/\w+\.u_scale/)
  })

  it('the preamble still reports what the host must ensure', () => {
    expect(emitGlslFragment(include).preamble).toContain('#version 300 es')
  })

  it('survives minify() — which the block-parsing surgery could not', () => {
    // `lowerLooseUniformBlock` split the emitted block on '\n' and trimmed each line, so a
    // text plugin that collapses whitespace broke it outright. That is why the consumer
    // could not use production emit at all. The lowering being IR-level removes the
    // constraint: the declaration is loose BEFORE any text pass runs.
    const min = emitGlslFragment(include, undefined, { plugins: [minify()] })
    expect(min.source).toContain('u_scale')
    expect(min.source).toContain('u_viewport_px')
    expect(min.source).not.toContain('layout(std140)')
  })

  it('reflect() still describes it — the surgery bypassed reflection entirely', () => {
    const owners = reflect(include)
      .bindGroups.flatMap((g) => g.entries)
      .map((e) => `${e.name}:${e.owner}`)
      .sort()
    expect(owners).toEqual(['u_scale:host', 'u_viewport_px:host'])
  })
})
