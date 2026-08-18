// ═══ Shader DSL — the Backend plugin contract ═══
//
// A Backend is a target writer (WGSL, GLSL ES 3.00, later SPIR-V/MSL). The emit
// driver is generic; it calls into the backend for every target-specific
// decision. The IR carries no target lexemes — all spelling lives here.
//
// S1 scope: the type + literal spelling surface + a capability model. The
// intrinsic-spelling surface (`intrinsic`) and the IO/resource lowering are
// threaded in later steps; until then the WGSL writer keeps its inline spelling
// and remains byte-identical.

import type {
  ShaderType,
  ConstDecl,
  OverrideDecl,
  StructDecl,
  BindingDecl,
  FuncDecl,
  ModuleDecl,
  Capability,
  RawStmt,
} from './ir'
import { ALL_CAPABILITIES } from './ir/nodes'
import { ShaderDslError } from './diagnostics/error'
import type { ParenMode } from './emit'

// The `Capability` vocabulary lives with the IR data shapes (ir/nodes.ts) — a module
// DECLARES the caps it needs there (surfaced publicly via the ir barrel). This file is
// the BACKEND side: which caps a target HAS (Capabilities), consuming the type only.

/** What ONE capability costs on ONE target (#1670) — the row of a backend's
 *  `capProfile`. Both fields are optional and mean different things:
 *  - `directive` — the token the EMITTED SOURCE must carry for this target to accept
 *    the feature: WGSL `enable <directive>;`, GLSL ES 3.00
 *    `#extension <directive> : require`. Absent ⇒ the feature costs zero emitted bytes.
 *  - `hostFeature` — what the HOST must activate before pipeline creation:
 *    `gl.getExtension('<hostFeature>')` on WebGL2, a `requiredFeatures: ['<hostFeature>']`
 *    entry on WebGPU. Absent ⇒ core on that target, nothing to request.
 *  An EMPTY row (`{}`) is meaningful: the target supports the cap outright — no
 *  directive, no host activation (WGSL storage buffers, WebGPU float render targets). */
export interface CapSupport {
  readonly directive?: string
  readonly hostFeature?: string
}

/** THE per-backend capability table (#1670) — the SINGLE authority for what a target
 *  supports. Membership is support: a cap with a row is spellable on this target, a cap
 *  without one fails closed at assertCaps naming it. Coverage is DERIVED from the keys
 *  (`Capabilities.fromProfile`), the directive header from the rows' `directive`s, and
 *  the host-activation list from their `hostFeature`s (`hostFeaturesFor`) — so the three
 *  cannot drift apart. This replaced the hand-synced `caps`-set + `WGSL_ENABLE`-map pair
 *  the WGSL backend used to carry (CLAUDE.md §12, the second-ratchet lesson). */
export type CapProfile = Readonly<Partial<Record<Capability, CapSupport>>>

/** A backend's capability COVERAGE, built once via `Capabilities.fromProfile(backend.capProfile)`
 *  — membership in the profile's keys IS support, so there is no second cached set that could
 *  drift from it (#1670). `assertCaps(backend, module)` is the real consumer: it derives what a
 *  module actually needs with `requiredCaps` (a storage binding → `storageBuffer`, a `@compute`
 *  entry → `compute`, an MSAA texture load → `msaaTextureLoad`, plus whatever the author listed
 *  in `enables`), then calls `.covers(req)` — and on a miss, `.missing(req)` names exactly which
 *  caps the target cannot spell, so the thrown `UnsupportedFeatureError` says "backend
 *  'glsl-es300' cannot emit this module — missing capabilities: compute" instead of the GLSL
 *  writer discovering the same fact mid-emit with no module-level context. This is why GLSL ES
 *  3.00's `capProfile` has NO row for `storageBuffer`, `compute`, or `msaaTextureLoad` even
 *  though the GLSL writer itself never gets asked to emit them: the gate runs first.
 *
 *  Exported from `@xgis/shader-dsl`.
 */
export class Capabilities {
  constructor(private readonly set: ReadonlySet<Capability>) {}
  /** The caps a `capProfile` declares — its KEYS. The only way a coverage decision
   *  should be made, so profile membership and capability coverage are one fact (#1670). */
  static fromProfile(profile: CapProfile): Capabilities {
    // Filter explicitly-undefined rows: `exactOptionalPropertyTypes` is OFF in this
    // repo, so `{ f16: undefined }` typechecks as a CapProfile and its key would
    // otherwise count as support for a cap the target cannot spell.
    return new Capabilities(
      new Set(
        Object.entries(profile)
          .filter(([, v]) => v !== undefined)
          .map(([k]) => k) as Capability[],
      ),
    )
  }
  has(c: Capability): boolean {
    return this.set.has(c)
  }
  /** True iff this target supports everything `reqs` needs. */
  covers(reqs: Iterable<Capability>): boolean {
    for (const c of reqs) if (!this.set.has(c)) return false
    return true
  }
  missing(reqs: Iterable<Capability>): Capability[] {
    const m: Capability[] = []
    for (const c of reqs) if (!this.set.has(c)) m.push(c)
    return m
  }
}

/** THE host-activation lookup (#1670): the concrete per-target feature strings a host
 *  must have ACTIVE before it creates a pipeline for a module needing `caps` — WebGL2
 *  `gl.getExtension('EXT_color_buffer_float')`, WebGPU
 *  `requestDevice({ requiredFeatures: ['float32-filterable'] })`.
 *
 *  Feed it `reflect(m).requiredFeatures`. Rows with no `hostFeature` (the cap is core on
 *  this target, or purely a source directive) contribute NOTHING — which is why this
 *  exists as one function rather than a `.map(c => be.capProfile[c]?.hostFeature)` at
 *  each call site: that shape yields `undefined` holes a host then passes to
 *  `getExtension` / `requiredFeatures` verbatim. */
export function hostFeaturesFor(be: Backend, caps: readonly Capability[]): readonly string[] {
  return caps.flatMap((c) => {
    const h = be.capProfile[c]?.hostFeature
    return h === undefined ? [] : [h]
  })
}

/** The target-writer contract every backend (WGSL, GLSL ES 3.00, and any future SPIR-V/MSL
 *  writer) implements so the shared emit driver (`core/emit.ts`) never branches on which target
 *  it is emitting for — every target-specific decision (type/literal/intrinsic spelling, the
 *  handful of divergent statement fragments, and the module-level declaration surface) is a
 *  method call into whichever `Backend` the caller passed. `capProfile` is the one piece a
 *  backend does NOT spell code for: it is read by `assertCaps` (`passes/required-caps.ts`),
 *  which the shared `lowerForBackend` runs before ANY of these methods are called, so a module
 *  needing a capability a target lacks throws `UnsupportedFeatureError` — naming the missing
 *  caps — before the backend gets a chance to emit source the driver would reject. Concretely:
 *  GLSL ES 3.00 (WebGL2) has no row for `storageBuffer` / `compute` / `msaaTextureLoad` at all
 *  (WebGL2 has neither compute shaders nor multisampled texture loads), where WGSL's rows for
 *  the same three are empty objects — core, nothing to declare or activate. A cap can also be
 *  core on one target and an EXTENSION on the other: `floatRenderTarget` is `{}` (free) on WGSL
 *  but needs `EXT_color_buffer_float` activated on GLSL. A backend whose declaration surface
 *  can't represent something (e.g. GLSL has no binding/struct syntax at a bare emit site) fails
 *  closed there too, the same way.
 *
 *  Exported from `@xgis/shader-dsl`.
 */
export interface Backend {
  readonly id: string
  /** THE capability table for this target (#1670) — neutral id → { directive?,
   *  hostFeature? }, and the ONLY capability authority a backend carries. Coverage is
   *  `Capabilities.fromProfile(capProfile)` (assertCaps / diagnose build it on the spot —
   *  9 keys), `modulePreamble` reads the `directive` fields off the same rows, and
   *  `hostFeaturesFor` the `hostFeature`s, so a cap cannot be supported-but-undirected
   *  (or directed-but-unsupported) by construction. Add a target's support for a feature
   *  by adding ONE row. */
  readonly capProfile: CapProfile
  /** OPTIONAL — the `@builtin(<id>)` ids this target GENUINELY LACKS (#1672), each
   *  mapped to the message tail printed after `<backend id>: @builtin(<id>)`. The
   *  shared pre-pass (passes/required-caps.ts `assertBuiltins`, run from
   *  lowerForBackend beside assertCaps) fails closed on any of them, so a GLSL-ism
   *  is named at the author's module instead of emitting a string the driver
   *  rejects far downstream. A backend whose OWN IO lowering already rejects every
   *  unmapped builtin (GLSL ES 3.00 — builtinIn/builtinOut) omits this. */
  readonly absentBuiltins?: ReadonlyMap<string, string>
  /** Spell a type for this target (e.g. WGSL `vec3<f32>` vs GLSL `vec3`). */
  typeName(t: ShaderType): string
  /** Spell a scalar literal for this target (e.g. WGSL `1u` vs GLSL `1`). */
  literal(value: number | boolean, t: ShaderType): string
  /** Spell an intrinsic / builtin call with already-emitted arg strings.
   *  `name` is the WGSL-canonical id (today's `call.fn`, plus the reserved
   *  `'select'`). The WGSL writer reproduces `name(args)` byte-identically;
   *  a GLSL writer remaps the divergent ones (textureSample→texture,
   *  unpack4x8unorm→unpackUnorm4x8, bitcast<u32>→floatBitsToUint,
   *  select(f,t,c)→ternary) and passes the rest through. User-defined function
   *  calls also flow through here and pass through unchanged. */
  intrinsic(name: string, args: string[]): string

  // ── Divergent statement/declaration fragments ──
  // The control-flow walk (if/for/switch/return/assign/…) is shared in
  // core/emit.ts; only these fragments differ between targets. Each returns the
  // fragment WITHOUT leading indentation or trailing `;` (the walk adds those),
  // except constDecl which is a full line.
  /** `let n = init` (WGSL, type inferred) vs `T n = init` (GLSL). */
  localLet(name: string, type: ShaderType, init: string): string
  /** `var n: T[= init]` (WGSL) vs `T n[= init]` (GLSL). */
  localVar(name: string, type: ShaderType, init?: string): string
  /** A module-level const declaration line, incl. trailing `;`:
   *  `const n: T = v;` (WGSL) vs `const T n = v;` (GLSL). */
  constDecl(name: string, type: ShaderType, value: string): string
  /** A `switch` case label: `${v}u` for a u32 scrutinee on WGSL; `${v}` on GLSL. */
  caseLabel(value: number, scrutType: ShaderType): string
  /** The `switch` head: `switch ${scrut} {` (WGSL) vs `switch (${scrut}) {` (GLSL). */
  switchHead(scrut: string): string
  /** Spelling for a FLOAT `%` binop, for a target whose native `%` is integer-only.
   *  GLSL ES 3.00 rejects float `%` outright, so without this the shared walk emitted
   *  it verbatim — valid WGSL, a GLSL compile error at the driver (the
   *  works-on-one-backend trap). The operand texts arrive FULLY parenthesized (atoms
   *  aside), and the returned expression must be self-parenthesized and must
   *  reproduce WGSL float-`%` semantics: TRUNC-mod, `a - b·trunc(a/b)` — NOT GLSL
   *  `mod()`, which is floor-mod and disagrees on negative operands. Absent (WGSL):
   *  the native `%` is emitted, byte-identical to the historical spelling. */
  readonly floatMod?: (a: string, b: string) => string
  /** A per-case terminator. WGSL switch cases do NOT fall through (each case is
   *  self-contained), so this is absent. C-style GLSL switch DOES fall through, so the
   *  GLSL backend returns `break;` — without it every match() arm leaks into the next
   *  (every kernel returns the LAST/default arm; caught on real WebGL2, not headless). */
  readonly caseBreak?: string
  /** A `raw` Stmt — the verbatim-splice escape hatch. Takes the NODE, not a
   *  string (#1671): the node carries a PER-TARGET payload (`wgsl` / `glsl`), so
   *  each backend picks its own side here and the shared emit walk (emit.ts)
   *  stays target-blind. A backend whose side is absent fails closed
   *  (UnsupportedFeatureError / SD0030) — symmetrically, in both directions. */
  rawStmt(s: RawStmt): string
  /** An un-swapped `placeholder` Stmt. WGSL emits a defensive comment; non-WGSL fails closed. */
  placeholderStmt(tag: string): string

  // ── Module-level declaration surface ──
  // The module assembly walk (validate → assertCaps → autoVars → lowerModule →
  // optimize → assemble) is shared in core/emit.ts (`emitModule`); only these
  // per-declaration spellings differ between targets. A backend that does not
  // support a declaration (e.g. GLSL ES bindings/structs) fails closed here.
  /** A module-level const declaration line, incl. trailing `;`. */
  emitConst(c: ConstDecl): string
  /** OPTIONAL — a module-level SPECIALIZATION CONSTANT declaration (#923). The WGSL
   *  writer emits `override name: T = default;` (host-overridable at pipeline creation
   *  via `constants: {}`); the GLSL writer emits a `#ifndef/#define/#endif`
   *  default-value permutation seam (host specializes by re-emitting with
   *  `emitGlslModule`'s `overrideValues`, which the emitter places after the `#version`
   *  preamble — a prepended `#define` is invalid GLSL). A backend with no override
   *  surface omits this — assembly then skips overrides for that target. */
  emitOverride?(o: OverrideDecl): string
  /** A struct declaration block. */
  emitStruct(s: StructDecl): string
  /** A resource binding declaration line. */
  emitBinding(b: BindingDecl): string
  /** A function declaration block (signature + emitted body). */
  /** `parens` selects how much parenthesis the shared expression walk writes
   *  (core/emit.ts `ParenMode`). Omitted ⇒ 'full', the historical bytes — a
   *  backend just forwards it to `emitBody`. */
  emitFunc(f: FuncDecl, parens?: ParenMode): string
  /** The backend's emit-time optimization of the lowered module — today BOTH
   *  backends run the full `fixpoint` pipeline (#763 H1; wgsl.ts / glsl.ts
   *  `optimize:`). Kept per-backend so a target can still diverge without touching
   *  the shared driver. Runs after lowerModule(autoVars(m)), before assembly. */
  optimize(lowered: ModuleDecl): ModuleDecl
  /** OPTIONAL module header carrying the SOURCE-LEVEL directives the module's declared
   *  caps need on this target (#628, #1670): one line per `m.enables` entry whose
   *  `capProfile` row has a `directive` — WGSL `enable <d>;`, GLSL ES 3.00
   *  `#extension <d> : require` — deduped + sorted for a deterministic byte order.
   *
   *  ONE contract for every backend: the directive LINES joined by '\n', with NO
   *  trailing separator, and '' when nothing is directed (every declared cap host-side,
   *  or none declared). Separation from what follows belongs to the assembler, not here —
   *  a per-backend trailing rule was a second thing to keep in sync, and the caller
   *  already knows its own slot. WHERE the string lands IS the target assembler's
   *  business, because the two targets have different legal slots: the shared WGSL driver
   *  PREPENDS it to the whole module (emit.ts, adding its own blank line), while the GLSL
   *  assembler SPLICES it as one `parts` entry after `#version 300 es` (ES 3.00 §3.4 —
   *  `#extension` must precede any non-preprocessor token, and `#version` must lead the
   *  file). Both are fed the AUTHORED module: `enables` is an authoring-level
   *  declaration, and reading it off the lowered module would make the header depend on
   *  every pass preserving it — the exact sibling-divergence this repo pays for.
   *  (`fp64Lower` does now carry `enables` through its rebuild, #1670, but that is for
   *  reflection of a lowered module — not a licence to derive the header from one.) */
  modulePreamble?(m: ModuleDecl): string
}

/** Emitting a feature a target does not support is a typed error, never a silent
 *  mis-emit. Thrown by the capability gate (assertCaps) and by individual backend
 *  fragments that hit an unsupported construct. */
export class UnsupportedFeatureError extends ShaderDslError {
  constructor(message: string) {
    super({ code: 'SD0030', message })
    this.name = 'UnsupportedFeatureError'
  }
}

// ── Capability × backend matrix (#1717) ──────────────────────────────────────

/** How one backend supports one capability.
 *  - `'native'`      — supported, nothing to emit and nothing for the host to turn on.
 *  - `'directive'`   — supported, but the SOURCE must declare it (`enable f16;`,
 *                      `#extension … : require`). The emitter writes it.
 *  - `'host-feature'`— supported, but the HOST must activate it before pipeline creation
 *                      (a WebGPU device feature / a WebGL2 extension). `hostFeaturesFor`
 *                      is the lookup.
 *  - `'unsupported'` — the target has no row: emit FAILS CLOSED with SD0030 rather than
 *                      writing source the driver would reject.
 *
 *  A row can be both directive and host-feature; `'directive'` wins in that case, because
 *  it is the half a reader of the emitted source can see. */
export type CapSupportKind = 'native' | 'directive' | 'host-feature' | 'unsupported'

/** One row of the capability matrix (#1717) — a capability and how each backend takes it. */
export interface CapabilityRow {
  readonly capability: Capability
  /** Keyed by `Backend.id`, one entry per backend passed in. */
  readonly support: Readonly<Record<string, CapSupportKind>>
  /** False for the three DERIVED resource caps, which `requiredCaps` infers from the
   *  module's shape and `DeclarableCapability` makes unrepresentable in `enables`. */
  readonly declarable: boolean
}

/**
 * The capability × backend support matrix (#1717 Ask 2), DERIVED from the backends'
 * own `capProfile`s rather than transcribed.
 *
 * #1717 asked for this as a documentation page. It is a function instead, because the
 * repo already has three authorities describing this API (#1700) and a hand-written table
 * would be the fourth — one that goes stale silently, since nothing checks prose against
 * a `capProfile`. A renderer can turn this into the page; the data has one home.
 *
 * ```ts
 * capabilityMatrix([wgslBackend, glslEs300Backend])
 * // → [{ capability: 'f16', support: { wgsl: 'directive', 'glsl-es300': 'unsupported' }, … }, …]
 * ```
 *
 * @param backends - the backends to compare, in the column order you want.
 * @returns one row per {@link Capability}, in `ALL_CAPABILITIES` order.
 */
export function capabilityMatrix(backends: readonly Backend[]): readonly CapabilityRow[] {
  return ALL_CAPABILITIES.map((capability) => ({
    capability,
    support: Object.fromEntries(
      backends.map((be) => {
        const row = be.capProfile[capability]
        return [
          be.id,
          row === undefined
            ? 'unsupported'
            : row.directive
              ? 'directive'
              : row.hostFeature
                ? 'host-feature'
                : 'native',
        ]
      }),
    ),
    declarable: !DERIVED_CAPABILITIES.has(capability),
  }))
}

/** The three caps `requiredCaps` derives from a module's SHAPE — a storage binding, a
 *  `@compute` entry, an MSAA texture load — and which `DeclarableCapability` therefore
 *  makes unrepresentable in `enables` (#1681 A2). */
const DERIVED_CAPABILITIES: ReadonlySet<Capability> = new Set([
  'storageBuffer',
  'compute',
  'msaaTextureLoad',
])
