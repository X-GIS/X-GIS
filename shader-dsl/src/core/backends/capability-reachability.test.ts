// ═══ Capability-reachability ratchet (#1681 A3) ═══
//
// A `Capability` is a PROMISE to an author: declare it (or write the shape that derives
// it) and the DSL will let you use the feature. Three of the nine keep only half of that
// promise — the declaration rides in `enables`, a `capProfile` row accepts it, the
// emitted source even carries a directive, and there is NOTHING an author can then
// write that uses it:
//
//   f16        `enable f16;` on WGSL, but `Scalar` is f32|i32|u32|bool (ir/types.ts:9)
//              and every scalar/vector/matrix type keys off it, so no f16 VALUE can be
//              declared. On WebGPU this is worse than a no-op: `enable f16;` requires
//              the `shader-f16` device feature, so a module that enables it and uses
//              nothing can FAIL pipeline creation on a device that lacks it.
//   subgroups  same shape — `enable subgroups;` and not one subgroup intrinsic behind it.
//   multiview  emits `#extension GL_OVR_multiview2 : require` and renders SINGLE-VIEW:
//              neither `layout(num_views = N) in;` nor `gl_ViewID_OVR` is authorable.
//
// This gate turns that from prose scattered across three doc comments into DATA. Every
// capability names a WITNESS — the concrete thing that lets an author actually USE it —
// and the witness is RESOLVED against the real surface: a module shape is fed to the
// real `requiredCaps`, a type constant is looked up on the real `core/ir` barrel and
// spelled by a real backend, an intrinsic id is looked up in the real registry, a
// `@builtin` id is driven through a real GLSL emit. Nothing here resolves against a
// string this file also owns — a hardcoded list would prove only that the list exists.
//
// SHRINK-ONLY IN BOTH DIRECTIONS, the earth-literal-ratchet contract
// (shared/src/earth-literal-ratchet.test.ts):
//   - a capability whose witness does NOT resolve and is not allowlisted → RED;
//   - an allowlisted capability whose witness DOES resolve → RED, so the entry must be
//     deleted in the same commit that made the cap reachable.
// A NEW capability cannot slip past either: `WITNESSES` is `Record<Capability, Witness>`,
// so adding a union member without a witness fails `tsc -p shader-dsl/tsconfig.tests.json`
// (the second half of `bun run build`), and the new entry then has to resolve or be
// allowlisted with a reason.
//
// NON-VACUITY (#996 / CLAUDE.md §12 — "the authority itself is seen"): the resolver is
// probed per kind with BOTH a known-good and a known-bad witness, so a resolver that
// broke into always-true or always-false cannot carry the two ratchet arms above.

import { describe, it, expect } from 'vitest'
import * as IR from '../ir/index.js'
import {
  module,
  fn,
  vec4,
  f32T,
  u32T,
  texture2dMsfT,
  arrayT,
  type Capability,
  type DeclarableCapability,
  type ModuleDecl,
  type ShaderType,
} from '../ir/index.js'
import { isKnownIntrinsic } from '../intrinsics.js'
import { requiredCaps } from '../passes/required-caps.js'
import { reflect } from '../reflect.js'
import { emitModule, wgslBackend } from './wgsl.js'
import { emitGlslModule, glslEs300Backend } from './glsl.js'

// ── The probe module: the smallest thing that emits on BOTH backends ──
const fragProbe = (enables?: readonly DeclarableCapability[]): ModuleDecl =>
  module({
    enables,
    funcs: [
      fn('fs_probe', {}, () => vec4(1, 0, 0, 1), { stage: 'fragment', retAttr: '@location(0)' }),
    ],
  })

/** The probe with ONE entry param carrying `@builtin(<id>)`. Every entry param goes
 *  through the GLSL writer's `builtinInRead` whether the body reads it or not
 *  (backends/glsl.ts — main() gathers each param before the call), so an unmapped
 *  builtin throws here rather than silently emitting nothing. */
const builtinProbe = (id: string): ModuleDecl => {
  const base = fragProbe()
  return {
    ...base,
    funcs: base.funcs.map((f) => ({
      ...f,
      params: [{ name: 'probe', type: u32T, builtin: id, attr: `@builtin(${id})` }],
    })),
  }
}

// ── Witness kinds ──
//
// Each names a DIFFERENT authoring surface, and each resolves by asking that surface,
// never by consulting a table in this file.
type Witness =
  /** A module SHAPE the author writes; resolves iff the real `requiredCaps` derives the
   *  capability from it. The witness for the three DERIVED caps. */
  | { readonly kind: 'moduleShape'; readonly what: string; readonly build: () => ModuleDecl }
  /** A `ShaderType` constant on the public `core/ir` barrel (`f32T`, `u32T`, …) — the
   *  thing an author needs before a VALUE of the capability's type can exist. Resolves
   *  iff the export is there AND a real backend can spell it. */
  | { readonly kind: 'typeConstant'; readonly id: string }
  /** An intrinsic id that must exist in the real registry (`core/intrinsics.ts`). */
  | { readonly kind: 'intrinsic'; readonly id: string }
  /** A `@builtin(<id>)` an entry may read; resolves iff a real GLSL emit accepts it. */
  | { readonly kind: 'builtin'; readonly id: string }
  /** "Host-side only, nothing to author" — the capability changes what the DEVICE can
   *  do, not what the source may spell, so the WHOLE authoring surface is: declare it and
   *  the host learns of it. Resolves iff some backend carries the cap with NO directive
   *  (zero emitted bytes), `reflect().requiredFeatures` reports it, and the emit really is
   *  byte-identical to the enables-free one. A cap whose row carries a directive fails
   *  this by construction — which is what stops `hostOnly` becoming a rubber stamp. */
  | { readonly kind: 'hostOnly'; readonly cap: DeclarableCapability }

const hostOnly = (cap: DeclarableCapability): Witness => ({ kind: 'hostOnly', cap })

/** Human-readable identity of a witness — used in the failure messages so the report
 *  names the missing surface, not merely the capability. */
const describeWitness = (w: Witness): string => {
  switch (w.kind) {
    case 'moduleShape':
      return `module shape: ${w.what}`
    case 'typeConstant':
      return `ShaderType constant \`${w.id}\` on core/ir`
    case 'intrinsic':
      return `intrinsic \`${w.id}\` in the registry`
    case 'builtin':
      return `@builtin(${w.id}) readable by an entry`
    case 'hostOnly':
      return `host-side only (declare \`${w.cap}\` → reflect().requiredFeatures), nothing to author`
  }
}

// ── The resolvers — every one asks the REAL surface ──

const resolveModuleShape = (cap: Capability, build: () => ModuleDecl): boolean =>
  requiredCaps(build()).includes(cap)

const resolveTypeConstant = (id: string): boolean => {
  const v = (IR as unknown as Record<string, unknown>)[id]
  if (v === undefined || typeof v !== 'object' || v === null || !('kind' in v)) return false
  try {
    return wgslBackend.typeName(v as ShaderType).length > 0
  } catch {
    return false
  }
}

const resolveBuiltin = (id: string): boolean => {
  try {
    return emitGlslModule(builtinProbe(id), 'fragment').length > 0
  } catch {
    return false
  }
}

const resolveHostOnly = (cap: DeclarableCapability): boolean => {
  // A backend that SUPPORTS the cap and spends no source bytes on it. `directive`
  // present ⇒ the feature does have a source token, so "nothing to author" is a lie.
  const zeroCost = [glslEs300Backend, wgslBackend].find(
    (be) => be.capProfile[cap] !== undefined && be.capProfile[cap]?.directive === undefined,
  )
  if (zeroCost === undefined) return false
  const emitOn = (m: ModuleDecl): string =>
    zeroCost === wgslBackend ? emitModule(m) : emitGlslModule(m, 'fragment')
  try {
    // The host must LEARN of it (that is the entire surface) …
    if (!reflect(fragProbe([cap])).requiredFeatures.includes(cap)) return false
    // … and declaring it must move zero bytes.
    return emitOn(fragProbe([cap])) === emitOn(fragProbe())
  } catch {
    return false
  }
}

const resolve = (cap: Capability, w: Witness): boolean => {
  switch (w.kind) {
    case 'moduleShape':
      return resolveModuleShape(cap, w.build)
    case 'typeConstant':
      return resolveTypeConstant(w.id)
    case 'intrinsic':
      return isKnownIntrinsic(w.id)
    case 'builtin':
      return resolveBuiltin(w.id)
    case 'hostOnly':
      return resolveHostOnly(w.cap)
  }
}

// ── THE WITNESS TABLE ──
//
// Total over `Capability` by TYPE: a new union member with no entry here is a compile
// error, which is the half of the shrink-only contract a runtime scan cannot provide
// (the union has no runtime enumeration).
const WITNESSES: Readonly<Record<Capability, Witness>> = {
  // ── DERIVED resource caps — the witness is the module SHAPE requiredCaps reads. ──
  storageBuffer: {
    kind: 'moduleShape',
    what: "a binding with space 'storage'",
    build: () => ({
      consts: [],
      structs: [],
      bindings: [
        {
          group: 0,
          binding: 0,
          name: 'data',
          space: 'storage',
          access: 'read',
          type: arrayT(f32T),
        },
      ],
      funcs: [],
    }),
  },
  compute: {
    kind: 'moduleShape',
    what: "a func with stage 'compute'",
    build: () => ({
      consts: [],
      structs: [],
      bindings: [],
      funcs: [
        {
          name: 'cs_probe',
          stage: 'compute',
          workgroupSize: 64,
          params: [],
          ret: { kind: 'void' },
          body: [],
        },
      ],
    }),
  },
  msaaTextureLoad: {
    kind: 'moduleShape',
    what: "a texture binding with dim '2d-ms'",
    build: () => ({
      consts: [],
      structs: [],
      // `AddressSpace` is uniform|storage; a texture binding rides the uniform space
      // (the resource kind lives in `type`, which is what requiredCaps reads).
      bindings: [{ group: 0, binding: 0, name: 'src', space: 'uniform', type: texture2dMsfT }],
      funcs: [],
    }),
  },

  // ── OPT-IN caps whose whole surface is host activation. ──
  floatRenderTarget: hostOnly('floatRenderTarget'),
  float32Blend: hostOnly('float32Blend'),
  float32Filterable: hostOnly('float32Filterable'),

  // ── OPT-IN caps that promise an AUTHORING surface. ──
  // f16 needs a value type before anything can be f16: the repo's scalar constants are
  // `f32T` / `i32T` / `u32T` / `boolT`, so the missing one is `f16T` (and, behind it, an
  // `'f16'` member of `Scalar` — ir/types.ts:9 — that every vector/matrix arm keys off).
  f16: { kind: 'typeConstant', id: 'f16T' },
  // subgroups is a family of intrinsics; `subgroupAdd` is the canonical one. Any of them
  // landing in the registry makes the cap real — swap the id if a different one ships first.
  subgroups: { kind: 'intrinsic', id: 'subgroupAdd' },
  // multiview needs BOTH halves: a per-view id to read (`gl_ViewID_OVR`, which this DSL
  // would spell `@builtin(view_index)`) and the `layout(num_views = N) in;` qualifier.
  // The builtin is the half a witness can resolve mechanically; the qualifier has no
  // authoring surface at all, so a resolving witness here is necessary, not sufficient.
  multiview: { kind: 'builtin', id: 'view_index' },
}

/** Capabilities that are KNOWINGLY unreachable — declarable, gated, directive-emitting,
 *  and with nothing behind them. Each entry is a debt with a reason and an issue, not a
 *  waiver: the arms below fail if one becomes reachable and the entry survives. */
const UNREACHABLE_ALLOWLIST: Readonly<Partial<Record<Capability, string>>> = {
  // #1681 A3 — `enable f16;` emits on WGSL, but `Scalar` (ir/types.ts:9) is
  // f32|i32|u32|bool and every scalar/vector/matrix type keys off it, so no f16 value
  // can be declared, passed, or returned. Reachable only once `Scalar` gains 'f16' and
  // the type constants / promotion rules follow.
  f16: 'no f16 value type — Scalar is f32|i32|u32|bool (ir/types.ts:9) — #1681',
  // #1681 A3 — `enable subgroups;` emits on WGSL and the registry has no subgroup
  // intrinsic (subgroupAdd / subgroupBallot / subgroupBroadcast), so the directive is
  // the entire feature.
  subgroups: 'no subgroup intrinsic in the registry (core/intrinsics.ts) — #1681',
  // #1681 A3 — the GLSL row emits `#extension GL_OVR_multiview2 : require` and the
  // module still renders SINGLE-VIEW: `layout(num_views = N) in;` is unspellable and
  // `gl_ViewID_OVR` has no `@builtin` mapping. The cap exists to prove the `#extension`
  // path end to end (backends/glsl.ts GLSL_CAP_PROFILE says so in its own comment), and
  // this entry is the machine-checked version of that admission.
  multiview: 'directive-only — no gl_ViewID_OVR / num_views authoring surface — #1681',
}

describe('capability reachability (#1681 A3)', () => {
  // ── NON-VACUITY (#996) — the resolver SEES a known-good witness of every kind, and
  // does NOT see a known-bad one. Without both halves a resolver stuck at true would
  // green the ratchet arm and one stuck at false would green the allowlist arm.
  it('resolver sanity — every witness kind distinguishes a real surface from a missing one', () => {
    const probes: ReadonlyArray<readonly [string, Capability, Witness, boolean]> = [
      // moduleShape: the shape that DOES derive the cap vs a module without it.
      // The + probe builds its OWN storage binding rather than reusing
      // `WITNESSES.storageBuffer`. Sharing the table's entry here would make this arm red
      // for two different reasons — a broken RESOLVER and a broken WITNESS — and the whole
      // job of this arm is to tell those apart, so the failure message can name the
      // severed half (CLAUDE.md §12). Every other probe below is already self-contained;
      // this one was the exception.
      [
        'moduleShape +',
        'storageBuffer',
        {
          kind: 'moduleShape',
          what: "a module carrying a binding with space 'storage'",
          build: () => ({
            consts: [],
            structs: [],
            bindings: [
              {
                group: 0,
                binding: 0,
                name: 'probe_data',
                space: 'storage',
                access: 'read',
                type: arrayT(f32T),
              },
            ],
            funcs: [],
          }),
        },
        true,
      ],
      [
        'moduleShape -',
        'storageBuffer',
        {
          kind: 'moduleShape',
          what: 'a module with no storage binding',
          build: () => fragProbe(),
        },
        false,
      ],
      // typeConstant: a scalar constant that really is exported vs one that never was.
      ['typeConstant +', 'f16', { kind: 'typeConstant', id: 'f32T' }, true],
      ['typeConstant -', 'f16', { kind: 'typeConstant', id: 'f128T' }, false],
      // intrinsic: a registry id vs a nonexistent one.
      ['intrinsic +', 'subgroups', { kind: 'intrinsic', id: 'sin' }, true],
      ['intrinsic -', 'subgroups', { kind: 'intrinsic', id: 'xgisNotAnIntrinsic' }, false],
      // builtin: one the GLSL writer maps vs one it does not.
      ['builtin +', 'multiview', { kind: 'builtin', id: 'front_facing' }, true],
      ['builtin -', 'multiview', { kind: 'builtin', id: 'xgis_not_a_builtin' }, false],
      // hostOnly: a genuinely zero-byte cap vs one whose row carries a directive (f16 on
      // WGSL) — "nothing to author" must not be satisfiable by a cap with a source token.
      ['hostOnly +', 'floatRenderTarget', hostOnly('floatRenderTarget'), true],
      ['hostOnly -', 'f16', hostOnly('f16'), false],
    ]
    expect(
      probes
        .filter(([, cap, w, want]) => resolve(cap, w) !== want)
        .map(([label]) => label)
        .sort(),
      'The witness RESOLVER is broken — it no longer distinguishes a present authoring ' +
        'surface from an absent one, so both ratchet arms below are vacuous. Fix the ' +
        'resolver (or the probe, if the surface it names legitimately moved) before ' +
        'trusting anything else in this file.',
    ).toEqual([])
  })

  // ── The witness table is not stale (#996's companion assertion) ──
  it('every witnessed capability is one a backend actually profiles', () => {
    const profiled = new Set<string>([
      ...Object.keys(glslEs300Backend.capProfile),
      ...Object.keys(wgslBackend.capProfile),
    ])
    expect(
      Object.keys(WITNESSES)
        .filter((c) => !profiled.has(c))
        .sort(),
      'Capability with a witness here but NO row in either backend capProfile — the ' +
        'cap is unsupported everywhere and the witness is pointing at nothing. Delete ' +
        'the capability, or give some backend a row.',
    ).toEqual([])
  })

  // ── ARM 1 — no unreachable capability outside the allowlist ──
  it('every capability outside the allowlist has a witness that RESOLVES', () => {
    const unreachable = (Object.keys(WITNESSES) as Capability[])
      .filter((c) => UNREACHABLE_ALLOWLIST[c] === undefined)
      .filter((c) => !resolve(c, WITNESSES[c]))
      .map((c) => `${c} (witness: ${describeWitness(WITNESSES[c])})`)
      .sort()
    expect(
      unreachable,
      'Capability an author can DECLARE but cannot USE — its witness does not resolve ' +
        'against the real surface. That is not a harmless no-op: on WebGPU an `enable`d ' +
        'feature is a device requirement, so a module that enables it and uses nothing ' +
        'can fail pipeline creation on a device that lacks it. Build the authoring ' +
        'surface the witness names instead; if the capability is genuinely principled ' +
        'without one, add it to UNREACHABLE_ALLOWLIST here, in this commit, with a ' +
        'rationale and an issue number.',
    ).toEqual([])
  })

  // ── ARM 2 — the allowlist only shrinks ──
  it('an allowlisted capability that BECAME reachable must lose its entry', () => {
    const stale = (Object.keys(UNREACHABLE_ALLOWLIST) as Capability[])
      .filter((c) => resolve(c, WITNESSES[c]))
      .sort()
    expect(
      stale,
      'Allowlisted capability is now REACHABLE — its witness resolves. Delete the ' +
        'UNREACHABLE_ALLOWLIST entry in the SAME commit that made it reachable; this ' +
        'ratchet shrinks in both directions, so a stale exemption is a failure, not slack.',
    ).toEqual([])
  })

  // ── The allowlist entries must be reasons, not placeholders ──
  it('every allowlist entry states a reason and cites an issue', () => {
    expect(
      Object.entries(UNREACHABLE_ALLOWLIST)
        .filter(([, reason]) => reason === undefined || !/#\d+/.test(reason))
        .map(([cap]) => cap)
        .sort(),
      'UNREACHABLE_ALLOWLIST entry with no issue number — an exemption nobody can trace ' +
        'is an exemption nobody will remove.',
    ).toEqual([])
  })
})
