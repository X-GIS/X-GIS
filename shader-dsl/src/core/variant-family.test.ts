// ═══ variantFamily — the typed matrix, and the guarded lowering of it (#1712) ═══
//
// The acceptance criterion the issue names is the one asserted hardest here: every arm of
// `emitGuarded` must be byte-identical to the corresponding standalone variant. If it is,
// the preprocessor is a GLSL-only lowering of a typed matrix rather than a second authority
// on what each program contains — and the WGSL path, which cannot have a preprocessor at
// all, costs nothing.
//
// The two non-vacuity guards that matter: `selectGuardedArm` must select a DIFFERENT arm
// for different defines (otherwise the byte-identity sweep is comparing one arm to itself
// N times and would pass over a broken ladder), and the key-collision throw must fire —
// that throw is what turns AUTHORING.md §11's identity rule from prose into a gate.

import { describe, it, expect } from 'vitest'
import { fn, module, vec4, vec4fT, f32T } from './ir'
import { builtin, ioStruct } from './sot'
import { emitGlslFragment } from './backends/glsl'
import { isSemanticallyEqual, semanticDiff } from './semantic-diff'
import { selectGuardedArm, variantFamily } from './variant-family'

const FsOut = ioStruct('VfOut', { pos: builtin('position', vec4fT) })

/** Two axes, exactly the shape the consumer described: a boolean (terrain on/off) and an
 *  enumerated drape mode. Each point builds a genuinely different program. */
const family = variantFamily({
  axes: { terrain: [false, true], drape: ['ground', 'absolute'] } as const,
  build: ({ terrain, drape }) => {
    const lift = terrain ? 1.5 : 0.0
    const bias = drape === 'absolute' ? 10.0 : 0.0
    const elevate = fn('elevate', { t: f32T }, (p) => p.t.mul(lift).add(bias))
    return module({
      uses: [FsOut],
      funcs: [
        elevate,
        // The entry must actually CALL it: an uncalled helper is dead-code-eliminated, so
        // a fixture that only declares it emits the same bytes for every point in the
        // space — and every "this arm equals that variant" assertion below would then be
        // comparing identical text and proving nothing. The non-vacuity arm caught exactly
        // that while this test was being written.
        fn('vs_v', {}, () => FsOut.construct({ pos: vec4(elevate({ t: 1.0 }), 0.0, 0.0, 1.0) }), {
          stage: 'vertex',
        }),
      ],
    })
  },
  key: ({ terrain, drape }) => `${terrain ? 't' : 'f'}:${drape}`,
})

const DEFINES = {
  terrain: 'TERRAIN3D',
  drape: { ground: 'DRAPE_GROUND', absolute: 'DRAPE_ABSOLUTE' },
} as const

describe('variantFamily — the matrix', () => {
  it('enumerates the cartesian product, first axis slowest', () => {
    expect(family.keys).toEqual(['f:ground', 'f:absolute', 't:ground', 't:absolute'])
  })

  it('every variant carries its OWN reflection and module', () => {
    for (const v of family.variants) {
      expect(v.reflection.entries.map((e) => e.name)).toEqual(['vs_v'])
      expect(family.get(v.key)?.module).toBe(v.module)
    }
    expect(family.get('nope')).toBeUndefined()
  })

  it('the variants are genuinely DIFFERENT programs', () => {
    // Otherwise every arm assertion below would be trivially satisfiable.
    const [a, , , d] = family.variants
    expect(isSemanticallyEqual(semanticDiff(a!.module, d!.module))).toBe(false)
  })

  it('a key that does not name every axis is a collision, and throws', () => {
    // AUTHORING.md §11's identity rule, as a gate rather than prose. `ids.ts:64-70`
    // records the near-miss this prevents.
    expect(() =>
      variantFamily({
        axes: { terrain: [false, true], drape: ['ground', 'absolute'] },
        build: () => module({ uses: [FsOut], funcs: [] }),
        key: ({ drape }) => `${drape}`, // terrain omitted
      }),
    ).toThrow(/key collision/)
  })

  it('an axis with no values is rejected rather than silently emptying the matrix', () => {
    expect(() =>
      variantFamily({ axes: { a: [] }, build: () => module({ funcs: [] }), key: () => 'k' }),
    ).toThrow(/declares no values/)
  })
})

describe('variantFamily.emit — preprocessor-free, one source per key', () => {
  it('WGSL: N distinct sources, none containing a preprocessor directive', () => {
    const out = family.emit('wgsl')
    expect([...out.keys()]).toEqual(family.keys)
    for (const src of out.values()) {
      expect(src).not.toContain('#if')
      expect(src).not.toContain('#define')
    }
    expect(new Set(out.values()).size).toBe(family.keys.length)
  })

  it('GLSL: each source is a whole stage, header included', () => {
    for (const src of family.emit('glsl-es300', { stage: 'vertex' }).values()) {
      expect(src.startsWith('#version 300 es')).toBe(true)
      expect(src).not.toContain('#if')
    }
  })
})

describe('variantFamily.emitGuarded — a GENERATED ladder, provably equal to the variants', () => {
  const guarded = family.emitGuarded(DEFINES, { stage: 'vertex' })

  /** The macros a host would define for one point in the space. */
  const definesFor = (axes: (typeof family.variants)[number]['axes']): string[] => [
    ...(axes.terrain ? ['TERRAIN3D'] : []),
    DEFINES.drape[axes.drape],
  ]

  it('carries ONE preamble and one closed ladder', () => {
    expect(guarded.startsWith('#version 300 es')).toBe(true)
    expect((guarded.match(/^#version/gm) ?? []).length).toBe(1)
    expect((guarded.match(/^#if /gm) ?? []).length).toBe(1)
    expect((guarded.match(/^#elif /gm) ?? []).length).toBe(family.keys.length - 1)
    expect((guarded.match(/^#endif/gm) ?? []).length).toBe(1)
  })

  it('EVERY arm is byte-identical to that variant standalone', () => {
    for (const v of family.variants) {
      const arm = selectGuardedArm(guarded, definesFor(v.axes))
      const standalone = emitGlslFragment(v.module, 'vertex', { entryPoints: true }).source.replace(
        /\n$/,
        '',
      )
      expect(arm, `arm '${v.key}' diverged from its standalone emit`).toBe(standalone)
    }
  })

  it('selectGuardedArm really SELECTS — different defines, different arm', () => {
    // Non-vacuity for the sweep above: if this returned the same text regardless, the
    // byte-identity assertions would be comparing one arm against N variants and would
    // fail loudly — but if it returned the FIRST arm always, three of them would fail and
    // one would pass, which is a confusing signal. Pin the discrimination directly.
    const armA = selectGuardedArm(guarded, ['DRAPE_GROUND'])
    const armB = selectGuardedArm(guarded, ['TERRAIN3D', 'DRAPE_ABSOLUTE'])
    expect(armA).toBeTruthy()
    expect(armB).toBeTruthy()
    expect(armA).not.toBe(armB)
  })

  it('no arm matches when the host defines nothing the ladder names', () => {
    expect(selectGuardedArm(guarded, ['SOMETHING_ELSE'])).toBeUndefined()
  })

  it('fails closed when two variants need different preambles', () => {
    // `#version` must lead the file, so one guarded source can carry only one preamble.
    // Picking a variant's silently would emit a program whose extensions are wrong for
    // every other arm.
    const divergent = variantFamily({
      axes: { wide: [false, true] },
      build: ({ wide }) =>
        module({
          uses: [FsOut],
          funcs: [
            fn('vs_d', {}, () => FsOut.construct({ pos: vec4(0, 0, 0, 1) }), { stage: 'vertex' }),
          ],
          ...(wide ? { enables: ['multiview' as const] } : {}),
        }),
      key: ({ wide }) => (wide ? 'w' : 'n'),
    })
    expect(() => divergent.emitGuarded({ wide: 'WIDE' }, { stage: 'vertex' })).toThrow(
      /different[\s\S]*preamble/,
    )
  })

  it('a non-boolean axis given a single define name is rejected', () => {
    expect(() =>
      family.emitGuarded({ terrain: 'TERRAIN3D', drape: 'DRAPE' } as never, { stage: 'vertex' }),
    ).toThrow(/non-boolean value/)
  })
})
