// ═══ linkVariants (#1715 Problem A) — the aggregation, driven by a recorder ═══
//
// This file proves the LOGIC: every variant is attempted, the right step is blamed, the
// driver's log survives, and GL objects are released. It cannot prove that real GLSL links —
// that needs a real driver, and it happens in playground/e2e/_variant-link-gate.spec.ts
// against headless WebGL2. Both halves are needed and neither substitutes for the other:
// a recorder cannot reject bad GLSL, and a driver run cannot easily be made to fail on
// demand at each of the three steps.
//
// The recorder is scripted by which SOURCE it is handed, not by call order, so the arms stay
// meaningful if the implementation reorders its calls.

import { describe, it, expect } from 'vitest'
import { builtin, ioStruct, uniformStruct } from './sot'
import { fn, module, vec4, f32T, vec4fT } from './ir'
import { variantFamily } from './variant-family'
import { linkVariants, type GlLinker } from './variant-link'

const VsOut = ioStruct('VOut', { pos: builtin('position', vec4fT) })

/** Two boolean axes → four variants, each emitting different bytes (the `scale` uniform is
 *  read only when `hasScale`), so a gate over them is not four copies of one program. */
const family = variantFamily({
  axes: { hasScale: [false, true] as const },
  build: ({ hasScale }) => {
    const u = uniformStruct('U', { group: 0, binding: 0, as: 'u' }, { scale: f32T })
    return module({
      uses: hasScale ? [VsOut, u] : [VsOut],
      funcs: [
        fn(
          'vs',
          {},
          () => VsOut.construct({ pos: vec4(hasScale ? u.field.scale : 1.0, 0.0, 0.0, 1.0) }),
          { stage: 'vertex' },
        ),
        fn('fs', {}, () => vec4(1.0, 0.0, 0.0, 1.0), { stage: 'fragment' }),
      ],
    })
  },
  key: ({ hasScale }) => `v/${hasScale ? 'scale' : 'plain'}`,
})

interface Recorded {
  readonly created: number
  readonly deleted: number
}

/** A GlLinker that fails whichever step the caller names, for the sources it is given.
 *  `failOn` is matched against the SOURCE text, so a test says "fail the fragment of the
 *  variant that mentions `u_scale`" rather than "fail the 3rd call". */
function recorder(opts?: {
  failVertexIf?: (src: string) => boolean
  failFragmentIf?: (src: string) => boolean
  failLink?: boolean
  nullShader?: boolean
}): GlLinker<{ src: string; type: number }, { id: number }> & { readonly stats: Recorded } {
  let created = 0
  let deleted = 0
  let progs = 0
  return {
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 10,
    LINK_STATUS: 11,
    createShader: (type) => {
      if (opts?.nullShader === true) return null
      created++
      return { src: '', type }
    },
    shaderSource: (sh, src) => {
      sh.src = src
    },
    compileShader: () => {},
    getShaderParameter: (sh) =>
      sh.type === 1
        ? !(opts?.failVertexIf?.(sh.src) ?? false)
        : !(opts?.failFragmentIf?.(sh.src) ?? false),
    getShaderInfoLog: (sh) => `log for ${sh.type === 1 ? 'vertex' : 'fragment'}`,
    createProgram: () => {
      created++
      return { id: progs++ }
    },
    attachShader: () => {},
    linkProgram: () => {},
    getProgramParameter: () => !(opts?.failLink ?? false),
    getProgramInfoLog: () => 'link log',
    deleteShader: () => {
      deleted++
    },
    deleteProgram: () => {
      deleted++
    },
    get stats() {
      return { created, deleted }
    },
  }
}

describe('linkVariants — enumerating the matrix', () => {
  it('returns one result per key, in family order', () => {
    const rows = linkVariants(recorder(), family)
    expect(rows.map((r) => r.key)).toEqual([...family.keys])
    expect(rows.every((r) => r.ok)).toBe(true)
  })

  it('the family really has more than one distinct program', () => {
    // Without this the arms below could all pass on a family that collapsed to one variant,
    // which is the shape a gate over a cartesian product silently degrades into.
    expect(family.keys.length).toBe(2)
    const vs = family.emit('glsl-es300', { stage: 'vertex' })
    expect(new Set(vs.values()).size).toBe(2)
  })
})

describe('linkVariants — blaming the right step', () => {
  it('reports a VERTEX compile failure against the variant whose source failed', () => {
    // Only the `scale` variant reads the uniform, so only its vertex source mentions it.
    const rows = linkVariants(recorder({ failVertexIf: (s) => s.includes('scale') }), family)
    const bad = rows.filter((r) => !r.ok)
    expect(bad).toHaveLength(1)
    expect(bad[0]!.key).toBe('v/scale')
    expect(bad[0]!.failedAt).toBe('vertex')
    expect(bad[0]!.log).toContain('log for vertex')
  })

  it('reports a FRAGMENT compile failure as fragment, not as link', () => {
    const rows = linkVariants(recorder({ failFragmentIf: () => true }), family)
    expect(rows.every((r) => r.failedAt === 'fragment')).toBe(true)
  })

  it('reports a LINK failure as link, with the program log', () => {
    const rows = linkVariants(recorder({ failLink: true }), family)
    expect(rows.every((r) => r.failedAt === 'link')).toBe(true)
    expect(rows[0]!.log).toBe('link log')
  })

  it('attempts EVERY variant, rather than stopping at the first failure', () => {
    // The useful output of a matrix gate is "these are broken", not "the first one is".
    const rows = linkVariants(recorder({ failLink: true }), family)
    expect(rows).toHaveLength(family.keys.length)
  })

  it('survives a context that hands back null', () => {
    const rows = linkVariants(recorder({ nullShader: true }), family)
    expect(rows.every((r) => !r.ok)).toBe(true)
    expect(rows[0]!.log).toContain('createShader returned null')
  })
})

describe('linkVariants — not leaking a program per variant', () => {
  it('deletes every GL object it created, on the success path', () => {
    // A cartesian product is hundreds of programs on a context usually shared with a page.
    const gl = recorder()
    linkVariants(gl, family)
    expect(gl.stats.deleted).toBe(gl.stats.created)
    expect(gl.stats.created).toBeGreaterThan(0)
  })

  it('deletes them on the failure paths too', () => {
    for (const opts of [
      { failVertexIf: () => true },
      { failFragmentIf: () => true },
      { failLink: true },
    ]) {
      const gl = recorder(opts)
      linkVariants(gl, family)
      expect(gl.stats.deleted, JSON.stringify(Object.keys(opts))).toBe(gl.stats.created)
    }
  })
})
