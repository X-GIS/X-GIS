// ═══ Shader DSL — variant families: the axes a HOST decides at runtime (#1712) ═══
//
// AUTHORING.md §11 is right that a preprocessor is unnecessary when WE decide the variant:
// a builder parameter plus a plain `if` is strictly better, because the losing arm is
// never built and its bindings never declared. The case §11 does not cover is when the
// HOST decides — MapLibre sets TERRAIN3D and a family of OVERLAY_DRAPE_* per draw from map
// state, and our shaders must agree with defines we do not own.
//
// The answer is not to hand-write `#ifdef` ladders around emitted functions. That output
// cannot exist on WGSL at all (no preprocessor), it is untyped text where a missing
// `#endif` or a misspelled define is invisible to `validate()` and `reflect()`, and it
// leaves reflection describing ONE emitted string while the host can select N programs.
//
// So the matrix itself becomes the authored thing:
//
//   family.variants            per-variant module + reflection + a stable key
//   family.emit(target)        one preprocessor-free source per key — the WGSL path,
//                              and the one a pipeline cache should prefer everywhere
//   family.emitGuarded(...)    GLSL-only, opt-in: ONE source with a GENERATED #if ladder,
//                              for a host that owns the define
//   family.emitGuardedFragment(...)
//                              the same ladder as a header-less FRAGMENT (#1711), since the
//                              reported shape puts the ladder inside an #include — and an
//                              include cannot carry a second #version
//
// `emitGuarded` is a lowering of a typed matrix, not hand-written text — which is what
// makes it checkable. Every arm is byte-identical to the corresponding standalone variant
// (`selectGuardedArm` recovers it, and the tests assert that for every variant), so the
// preprocessor buys the host its define without the WGSL path paying anything.
//
// The `key` is the part that outlives the rest. AUTHORING.md §11's identity rule — every
// axis you specialise on must appear in every key that names the program — is prose today,
// and `map/src/shaders/baked/ids.ts:64-70` records the near-miss it already cost. A key
// DERIVED from the axes cannot omit one.

import type { ModuleDecl } from './ir'
import { reflect, type Reflection } from './reflect'
import { emitGlslFragment, type GlslEmitOptions } from './backends/glsl'
import { emitModule } from './backends/wgsl'
import type { EmitOptions } from './emit'
import type { EmitFragment, FragmentDeclares } from './fragment'

/** One point in the axis space: each axis name mapped to one of its declared values. */
export type AxisValues<A extends Record<string, readonly unknown[]>> = {
  readonly [K in keyof A]: A[K][number]
}

/** What `variantFamily` is given. */
export interface VariantFamilySpec<A extends Record<string, readonly unknown[]>> {
  /** The axes, each as the list of values the host can select. */
  readonly axes: A
  /** Build the module for one point in the space — plain TS branching, exactly as
   *  AUTHORING.md §11 recommends. The losing arm is never built. */
  readonly build: (axes: AxisValues<A>) => ModuleDecl
  /** The program's identity. Must mention every axis `build` reads; a key that does not
   *  describe what the builder emitted is the sharpest footgun in this codebase
   *  (AUTHORING.md §11). Derive it from `axes` rather than writing it by hand. */
  readonly key: (axes: AxisValues<A>) => string
}

/** One built variant. */
export interface Variant<A extends Record<string, readonly unknown[]>> {
  readonly key: string
  readonly axes: AxisValues<A>
  readonly module: ModuleDecl
  /** This variant's own reflection — the point of a family over a single emit: N programs
   *  the host can select, each described. */
  readonly reflection: Reflection
}

/** How to spell each axis value as a preprocessor define for `emitGuarded`. A boolean axis
 *  takes a single name, defined when true; any other axis takes one name per value. */
export type GuardDefines<A extends Record<string, readonly unknown[]>> = {
  readonly [K in keyof A]: string | Readonly<Record<string, string>>
}

/** A built family. */
export interface VariantFamily<A extends Record<string, readonly unknown[]>> {
  readonly variants: readonly Variant<A>[]
  /** Every key, in `variants` order — the pipeline-cache / baked-artifact id set. */
  readonly keys: readonly string[]
  /** Look one variant up by key; `undefined` when the key names no variant. */
  get(key: string): Variant<A> | undefined
  /** One PREPROCESSOR-FREE source per key. The only shape WGSL can have, and the one a
   *  pipeline cache should prefer on GLSL too. */
  emit(target: 'wgsl', opts?: EmitOptions): ReadonlyMap<string, string>
  emit(
    target: 'glsl-es300',
    opts?: GlslEmitOptions & { stage?: 'vertex' | 'fragment' },
  ): ReadonlyMap<string, string>
  /** ONE GLSL source whose arms are selected by defines the HOST owns (#1712).
   *
   *  Opt-in, and GLSL-only by construction: this exists for a host that already sets the
   *  define (MapLibre today), not as the recommended shape. Every arm is byte-identical to
   *  the corresponding `emit()` source, so nothing about the preprocessor-free path is
   *  compromised by using it.
   *
   *  Fails closed when the variants disagree about their preamble: `#version` must lead
   *  the file, so a single guarded source can only carry ONE preamble, and silently
   *  picking a variant's would emit a program whose precision or extensions are wrong for
   *  the other arms. */
  emitGuarded(
    defines: GuardDefines<A>,
    opts?: GlslEmitOptions & { stage?: 'vertex' | 'fragment' },
  ): string
  /** The same generated ladder as {@link VariantFamily.emitGuarded}, as a header-less
   *  FRAGMENT (#1711) — for a host that owns the program and composes our declarations into
   *  it, which is the shape the guarded ladder was actually reported from.
   *
   *  `emitGuarded` bakes the preamble into its string because it returns a whole stage. An
   *  `#include` cannot carry a second `#version`, so composing a guarded ladder into a host
   *  program through that entry point means stripping the header again — the regex #1711
   *  exists to remove. Here the preamble comes back as data, exactly as
   *  {@link emitGlslFragment} returns it, and `[...preamble, '', source].join('\n')`
   *  reproduces `emitGuarded`'s output byte for byte.
   *
   *  `declares` and `requires` are the UNION across the arms, since the host's preprocessor
   *  picks the arm and the composer cannot know which: every name any arm declares is one
   *  the prelude must not collide with, and every symbol any arm needs is one it must
   *  provide. */
  emitGuardedFragment(
    defines: GuardDefines<A>,
    opts?: GlslEmitOptions & { stage?: 'vertex' | 'fragment' },
  ): EmitFragment
}

/** The cartesian product of the axes, in declaration order — the FIRST axis varies
 *  slowest, so the enumeration reads like nested loops written in the same order. */
function product<A extends Record<string, readonly unknown[]>>(axes: A): AxisValues<A>[] {
  let rows: Record<string, unknown>[] = [{}]
  for (const name of Object.keys(axes)) {
    const values = axes[name] as readonly unknown[]
    if (values.length === 0)
      throw new Error(`shader-dsl: variantFamily axis '${name}' declares no values`)
    rows = rows.flatMap((r) => values.map((v) => ({ ...r, [name]: v })))
  }
  return rows as AxisValues<A>[]
}

/** The `#if` condition selecting one variant: every axis's define, conjoined. */
function guardCondition<A extends Record<string, readonly unknown[]>>(
  axes: AxisValues<A>,
  defines: GuardDefines<A>,
): string {
  const terms: string[] = []
  for (const name of Object.keys(axes)) {
    const spec = defines[name as keyof A]
    const value = (axes as Record<string, unknown>)[name]
    if (typeof spec === 'string') {
      if (typeof value !== 'boolean')
        throw new Error(
          `shader-dsl: variantFamily axis '${name}' has non-boolean value ${JSON.stringify(value)}` +
            ` but a single define name — give it one define per value`,
        )
      terms.push(value ? `defined(${spec})` : `!defined(${spec})`)
    } else {
      const named = spec[String(value)]
      if (named === undefined)
        throw new Error(
          `shader-dsl: variantFamily axis '${name}' value ${JSON.stringify(value)} has no define`,
        )
      terms.push(`defined(${named})`)
    }
  }
  return terms.join(' && ')
}

/** Recover the arm a set of defined macros selects from an `emitGuarded` source.
 *
 *  Deliberately understands ONLY the ladder shape `emitGuarded` generates — `#if` /
 *  `#elif` / `#endif` at column 0, conditions built from `defined(X)` and `!defined(X)`
 *  joined by `&&`. It is not a GLSL preprocessor and must not grow into one; it exists so
 *  a test (and a consumer's own gate) can assert that each arm equals the standalone
 *  variant without shelling out to a compiler.
 *
 *  @param source - output of {@link VariantFamily.emitGuarded}.
 *  @param defined - the macro names the host would have defined.
 *  @returns the selected arm's text, or `undefined` when no arm matches.
 */
export function selectGuardedArm(source: string, defined: Iterable<string>): string | undefined {
  const on = new Set(defined)
  const holds = (cond: string): boolean =>
    cond.split('&&').every((raw) => {
      const t = raw.trim()
      const neg = t.startsWith('!')
      const m = /^!?defined\(([^)]+)\)$/.exec(t)
      if (!m) throw new Error(`shader-dsl: selectGuardedArm cannot read condition '${t}'`)
      return neg ? !on.has(m[1]!) : on.has(m[1]!)
    })

  const lines = source.split('\n')
  let active: string[] | undefined
  let collecting = false
  for (const line of lines) {
    if (line.startsWith('#if ') || line.startsWith('#elif ')) {
      collecting = active === undefined && holds(line.slice(line.indexOf(' ') + 1))
      if (collecting) active = []
      continue
    }
    if (line.startsWith('#endif')) {
      collecting = false
      continue
    }
    if (collecting) active!.push(line)
  }
  return active?.join('\n')
}

/**
 * Build a family of shader variants from a typed axis matrix (#1712).
 *
 * ```ts
 * const family = variantFamily({
 *   axes: { terrain: [false, true], drape: ['ground', 'absolute'] },
 *   build: ({ terrain, drape }) => module({ … }),   // plain TS branching (§11)
 *   key: ({ terrain, drape }) => `${terrain ? 't' : 'f'}:${drape}`,
 * })
 *
 * family.emit('wgsl')                                  // 4 preprocessor-free sources
 * family.emitGuarded({ terrain: 'TERRAIN3D', drape: { ground: 'DRAPE_GROUND', … } })
 * ```
 *
 * @param spec - the axes, the per-point builder, and the key derivation.
 * @returns the built family: every variant with its module, reflection and key, plus the
 *   two emit shapes.
 * @throws when an axis declares no values, or two points derive the same key — a
 *   collision means the key does not name every axis the builder read, which is the
 *   failure AUTHORING.md §11 warns about and `ids.ts` has already paid for once.
 */
export function variantFamily<A extends Record<string, readonly unknown[]>>(
  spec: VariantFamilySpec<A>,
): VariantFamily<A> {
  const variants: Variant<A>[] = product(spec.axes).map((axes) => {
    const m = spec.build(axes)
    return { key: spec.key(axes), axes, module: m, reflection: reflect(m) }
  })

  const byKey = new Map<string, Variant<A>>()
  for (const v of variants) {
    if (byKey.has(v.key))
      throw new Error(
        `shader-dsl: variantFamily key collision '${v.key}' — the key must mention every` +
          ` axis the builder reads, or two different programs share one cache id`,
      )
    byKey.set(v.key, v)
  }

  const emit = (
    target: 'wgsl' | 'glsl-es300',
    opts?: (EmitOptions | GlslEmitOptions) & { stage?: 'vertex' | 'fragment' },
  ): ReadonlyMap<string, string> =>
    new Map(
      variants.map((v) => [
        v.key,
        target === 'wgsl'
          ? emitModule(v.module, opts)
          : emitGuardedArmSource(v, opts as GlslEmitOptions & { stage?: 'vertex' | 'fragment' }),
      ]),
    )

  return {
    variants,
    keys: variants.map((v) => v.key),
    get: (k) => byKey.get(k),
    emit: emit as VariantFamily<A>['emit'],
    emitGuarded(defines, opts) {
      const { preamble, ladder } = buildGuarded(variants, defines, opts)
      return [...preamble, '', ...ladder, '#endif', ''].join('\n')
    },
    emitGuardedFragment(defines, opts) {
      const { preamble, ladder, declares, requires } = buildGuarded(variants, defines, opts)
      // Same pieces, joined one level up by the composer instead of here — which is what
      // makes `[...preamble, '', source]` reproduce emitGuarded byte for byte.
      return { source: [...ladder, '#endif', ''].join('\n'), preamble, declares, requires }
    },
  }
}

/** De-duplicate, preserving first-seen order — deterministic without imposing an order the
 *  per-arm manifests do not have (theirs is emit order, not alphabetical). */
const union = (lists: readonly (readonly string[])[]): readonly string[] => [
  ...new Set(lists.flat()),
]

/** The pieces both guarded emits are made of: the ONE preamble every arm must agree on, the
 *  `#if`/`#elif` arms, and the manifests unioned across them.
 *
 *  Shared so the two entry points cannot drift — the string form and the fragment form
 *  differ only in who joins the preamble to the ladder. */
function buildGuarded<A extends Record<string, readonly unknown[]>>(
  variants: readonly Variant<A>[],
  defines: GuardDefines<A>,
  opts?: GlslEmitOptions & { stage?: 'vertex' | 'fragment' },
): {
  preamble: readonly string[]
  ladder: readonly string[]
  declares: FragmentDeclares
  requires: readonly string[]
} {
  const frags = variants.map((v) => ({
    v,
    f: emitGlslFragment(v.module, opts?.stage, { ...opts, entryPoints: true }),
  }))
  const preamble = frags[0]!.f.preamble
  for (const { v, f } of frags)
    if (f.preamble.join('\n') !== preamble.join('\n'))
      throw new Error(
        `shader-dsl: variantFamily.emitGuarded — variant '${v.key}' needs a different` +
          ` preamble than '${frags[0]!.v.key}':\n  ${f.preamble.join(' | ')}\n  vs\n  ` +
          `${preamble.join(' | ')}\nOne guarded source can carry only one #version` +
          ` block, so these variants cannot share it — emit them separately.`,
      )
  const ladder = frags.map(({ v, f }, i) => {
    const head = `#${i === 0 ? 'if' : 'elif'} ${guardCondition(v.axes, defines)}`
    return `${head}\n${f.source.replace(/\n$/, '')}`
  })
  const d = frags.map(({ f }) => f.declares)
  return {
    preamble,
    ladder,
    declares: {
      functions: union(d.map((x) => x.functions)),
      structs: union(d.map((x) => x.structs)),
      bindings: union(d.map((x) => x.bindings)),
      consts: union(d.map((x) => x.consts)),
      overrides: union(d.map((x) => x.overrides)),
      entryPoints: union(d.map((x) => x.entryPoints)),
    },
    requires: union(frags.map(({ f }) => f.requires)),
  }
}

/** `emit('glsl-es300')`'s per-key source: the WHOLE stage, preamble included, since a
 *  standalone variant owns its own header. */
function emitGuardedArmSource(
  v: { readonly module: ModuleDecl },
  opts?: GlslEmitOptions & { stage?: 'vertex' | 'fragment' },
): string {
  const f = emitGlslFragment(v.module, opts?.stage, { ...opts, entryPoints: true })
  return [...f.preamble, '', f.source].join('\n')
}
