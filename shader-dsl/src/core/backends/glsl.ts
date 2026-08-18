// ═══ Shader DSL — GLSL ES 3.00 backend (WebGL2) ═══
//
// The second writer — proves the IR is target-neutral. It reuses the SHARED
// neutral walk (core/emit.ts) and provides GLSL spelling (types, literals,
// intrinsics) + the divergent declaration fragments (`T name = e` vs `let name =
// e`, GLSL `switch (x)` + int case labels, fail-closed raw/placeholder). The
// control-flow walk is NOT duplicated here.
//
// SCOPE (Phase 4): pure-function modules (projection / log-depth math) AND the
// IO/binding surface — a `uniform` struct binding lowers to a std140 UBO block
// (FED by the Phase-0 `wgslLayout` offset engine, so the GLSL block's byte
// offsets are the SAME offsets the host packs against), and `@vertex`/`@fragment`
// entry-IO lowers to GLSL `in`/`out` varyings + a synthesised `void main()`.
//
// TEXTURES: a sampled `2d` texture lowers to the fused `sampler2D`, and a `2d-array`
// one (#1651) to `sampler2DArray` — both CORE GLSL ES 3.00, so neither needs a
// Capability and the array sample/lod/fetch spellings live in the intrinsic registry
// (textureSampleArray / textureSampleLevelArray / textureLoadArray). An INTEGER
// element (#1703) prefixes the spelling — `usampler2D` / `isampler2DArray` / … — also
// core, also Capability-free; those are LOAD-ONLY in both targets (see TextureElem),
// so they reuse textureLoad/textureLoadArray with an integer result type and add no
// spelling of their own. `2d-ms` remains the one texture dim that FAILS CLOSED here.
//
// FAIL-CLOSED (GLSL ES 3.00 has no compute / MSAA-load): a `@compute` entry and a
// multisampled-texture load raise UnsupportedFeatureError — enforced UP FRONT by
// the shared capability gate (assertCaps, run inside lowerForBackend) because neither
// cap has a row in GLSL_CAP_PROFILE, so this writer never sees such a module.
// A `storage` binding is different: WebGL2 having no SSBO is a PLATFORM fact, not a
// caller choice, so emitGlslModule lowers storage to a data texture BY DEFAULT (see
// the emulation section below) — the caps gate then sees no storage binding at all.
// The unsupported SHAPES inside that emulation still fail closed — a non-array storage
// binding, a top-level array<u32/i32>, an i32 struct field (at declaration), and a
// mat / vec<u32> / nested-struct field (on ACCESS — an unread one passes).
//
// ─── COMPILE GATE ───
// glsl.test.ts (string-shape: version pragma, std140 block + engine-matched
// offsets, in/out varyings, main()) + the headless-WebGL2 gate cover the emit.

import type {
  ShaderType,
  ModuleDecl,
  StructDecl,
  BindingDecl,
  FuncDecl,
  Expr,
  Stmt,
} from '../ir/index.js'
import {
  texture2dfT,
  texture2duT,
  texture2diT,
  u32T,
  i32T,
  f32T,
  vec4fT,
  stageOf,
} from '../ir/index.js'
import { collectFnRefs, emptyRefSet, typeStructNames } from '../ir/collect-refs.js'
import { UnsupportedFeatureError, type Backend, type CapProfile } from '../backend.js'
import { spellIntrinsic, INTRINSIC_BINDING_REFS } from '../intrinsics.js'
import { fragmentRequires, type EmitFragment, type FragmentDeclares } from '../fragment.js'
import { bodyHasRaw } from '../passes/opt/dce.js'
import { mapExpr, mapStmt } from '../passes/opt/ir-transform.js'
import { analyzePortableKernel, isPortableComputeEntry } from '../passes/portable-kernel.js'
import { dslError } from '../diagnostics/error.js'
import { f32Lit } from './wgsl.js'
import {
  emitBody,
  emitExpr as emitExprNeutral,
  lowerForBackend,
  applyIRPlugins,
  applyTextPlugins,
  type EmitOptions,
  type ParenMode,
} from '../emit.js'
import { autoVars } from '../passes/opt/index.js'
import { wgslLayout } from '../reflect.js'
import { sanitizeReservedIdents } from './glsl-sanitize.js'
import { fixpoint } from '../passes/opt/index.js'

// UnsupportedFeatureError now lives in the backend contract; re-exported here so
// existing importers (`from './glsl'`) keep working.
export { UnsupportedFeatureError } from '../backend.js'

function glslType(t: ShaderType): string {
  switch (t.kind) {
    case 'scalar':
      return ({ f32: 'float', i32: 'int', u32: 'uint', bool: 'bool' } as const)[t.scalar]
    // Pre-lowering types only — fp64Lower rewrites f64/vec64 before emit (see
    // wgslType's twin arms). Reaching here = the pass was bypassed.
    case 'f64':
      throw dslError('SD0040', 'glslType(f64)')
    case 'vec64':
      throw dslError('SD0040', `glslType(vec${t.n}<f64>)`)
    case 'vec':
      return `${({ f32: 'vec', i32: 'ivec', u32: 'uvec' } as const)[t.elem]}${t.n}`
    case 'mat':
      // matNxN<f64> → DF64MatN before emit; reaching here = fp64Lower bypassed.
      if (t.elem === 'f64') throw dslError('SD0040', `glslType(mat${t.n}<f64>)`)
      return `mat${t.n}`
    case 'struct':
      return t.name
    case 'array': {
      if (t.size === undefined)
        throw new UnsupportedFeatureError(
          'glsl-es300: runtime-sized array (storage buffer) — needs a data-texture (later step)',
        )
      return `${glslType(t.elem)}[${t.size}]`
    }
    case 'texture': {
      // GLSL fuses texture+sampler into one combined sampler. '2d-array' (#1651) is
      // CORE GLSL ES 3.00 — sampler2DArray, no extension, no Capability. So are the
      // INTEGER prefixes (#1703): u32 → `usampler…`, i32 → `isampler…` (GLSL ES 3.00
      // §4.1.9 basic types). Exhaustive on BOTH axes — an unlisted elem is an index
      // error and an unlisted dim hits `satisfies never`, so a new texture shape must
      // fail compilation here rather than fall open to the FLOAT sampler2D (which
      // would compile and then read garbage through the wrong sampler type).
      const p = ({ f32: '', u32: 'u', i32: 'i' } as const)[t.elem]
      switch (t.dim) {
        case '2d-ms':
          throw new UnsupportedFeatureError(
            'glsl-es300: multisampled texture sampling — resolve first (later step)',
          )
        case '2d-array':
          return `${p}sampler2DArray`
        case '2d':
          return `${p}sampler2D`
        default:
          // Exhaustiveness on the ARM (#1703) — see typeKey's twin: with the texture
          // type a two-arm union, `t` is `never` here and has no `.dim` to check.
          return t satisfies never
      }
    }
    case 'sampler':
      throw new UnsupportedFeatureError(
        'glsl-es300: standalone sampler — fused into the combined sampler2D',
      )
    case 'void':
      return 'void'
  }
}

// An integer scalar/vector — GLSL ES requires `flat` interpolation on such inter-stage varyings.
function isIntType(t: ShaderType): boolean {
  return (
    (t.kind === 'scalar' && (t.scalar === 'i32' || t.scalar === 'u32')) ||
    (t.kind === 'vec' && (t.elem === 'i32' || t.elem === 'u32'))
  )
}

function glslLit(value: number | boolean, t: ShaderType): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (t.kind === 'scalar' && t.scalar === 'u32') return `${value}u`
  if (t.kind === 'scalar' && t.scalar === 'i32') return `${value}`
  return f32Lit(value)
}

// ── entry-IO attribute parsing ──
// IO is carried two ways in the IR: (1) the production pattern — an entry func's
// params/return are STRUCTS whose StructField.attr is `@location(n)`/`@builtin(b)`;
// (2) a bare param/return carrying location/builtin directly. Both flatten to the
// same GLSL varyings.

const LOCATION_RE = /@location\((\d+)\)/
const BUILTIN_RE = /@builtin\((\w+)\)/
const INTERPOLATE_RE = /@interpolate\((\w+)\)/

// Shared stage predicate (#763 S1/S3) — structured-first with attr fallback.
// GLSL has no compute stage; compute entries are handled by the emulation
// lowering (or rejected by the capability gate) before this predicate runs.
const isEntry = (f: FuncDecl): boolean => {
  const s = stageOf(f)
  return s === 'vertex' || s === 'fragment'
}

/** Define-before-use order for GLSL struct decls (#763 P5): DFS post-order over
 *  field-type references (struct fields + array-of-struct elements), restricted
 *  to the given set. WGSL accepts any order; GLSL has no forward declaration. */
function topoSortStructs(structs: readonly StructDecl[]): StructDecl[] {
  const byName = new Map(structs.map((s) => [s.name, s]))
  const out: StructDecl[] = []
  const done = new Set<string>()
  const visit = (s: StructDecl): void => {
    if (done.has(s.name)) return
    done.add(s.name)
    for (const f of s.fields) {
      const t = f.type.kind === 'array' ? f.type.elem : f.type
      if (t.kind === 'struct') {
        const dep = byName.get(t.name)
        if (dep) visit(dep)
      }
    }
    out.push(s)
  }
  for (const s of structs) visit(s)
  return out
}

/** String fallback ONLY (#740 R3): sot-authored fields carry structured
 *  location/builtin — read those via ioAttr() below. This regex path survives
 *  solely for hand-built FuncDecl literals and bare `retAttr` strings. */
function parseAttrString(attr: string | undefined): {
  location?: number
  builtin?: string
  interpolate?: string
} {
  if (!attr) return {}
  const loc = attr.match(LOCATION_RE)
  if (loc) {
    const interp = attr.match(INTERPOLATE_RE)
    return { location: Number(loc[1]), ...(interp ? { interpolate: interp[1] } : {}) }
  }
  const b = attr.match(BUILTIN_RE)
  if (b) return { builtin: b[1] }
  return {}
}

/** Structured-first IO attr read (#740 R3). `interpolate` rides along (#763 P4)
 *  so `@interpolate(flat)` float varyings emit GLSL `flat` — they used to
 *  interpolate smooth on WebGL2 while WGSL got provoking-vertex flat. */
function ioAttr(
  src:
    | {
        readonly location?: number
        readonly builtin?: string
        readonly interpolate?: string
        readonly attr?: string
      }
    | undefined,
): { location?: number; builtin?: string; interpolate?: string } {
  if (!src) return {}
  if (src.location !== undefined)
    return {
      location: src.location,
      ...(src.interpolate !== undefined ? { interpolate: src.interpolate } : {}),
    }
  if (src.builtin !== undefined) return { builtin: src.builtin }
  return parseAttrString(src.attr)
}

// ── builtin lowering: WGSL builtin name → GLSL global ──
// Direction-AND-stage dependent: an INPUT builtin reads FROM a gl_* global, an OUTPUT
// builtin writes TO one, and `position` differs by direction — a vertex shader WRITES
// gl_Position, a fragment shader READS clip-space position as gl_FragCoord (gl_Position
// is write-only in the vertex stage, unreadable in the fragment stage).
// NB on the fragment-input `position` mapping: gl_FragCoord's window-space origin is
// BOTTOM-left while WGSL's fragment `position` is TOP-left framebuffer space — a
// consumer that reads `.y` off this builtin needs a per-target flip (or must derive
// its quantity y-symmetrically) before the two backends agree pixel-for-pixel.
const BUILTIN_IN: Readonly<Record<string, string>> = {
  position: 'gl_FragCoord', // a readable @builtin(position) is a fragment input → gl_FragCoord
  vertex_index: 'gl_VertexID',
  instance_index: 'gl_InstanceID',
  front_facing: 'gl_FrontFacing',
}
// One name per semantic: `frag_coord` was a GLSL-only ALIAS of the fragment-input
// `position` row above, so a module authored against it emitted fine here and died
// only when the WGSL writer ran (works-on-WebGL2, fails-on-WebGPU — the asymmetry
// trap). The builtin vocabulary is WGSL's (`builtin(name, …)` docs); the alias now
// fails closed HERE too, with the same prescriptive remedy the WGSL denylist prints.
const BUILTIN_IN_REMEDY: Readonly<Record<string, string>> = {
  frag_coord:
    "spell it @builtin(position) on the fragment input — the builtin vocabulary is WGSL's, and this writer reads that as gl_FragCoord",
}
const BUILTIN_OUT: Readonly<Record<string, string>> = {
  position: 'gl_Position',
  frag_depth: 'gl_FragDepth',
}

function builtinIn(b: string): string {
  const g = BUILTIN_IN[b]
  if (!g) {
    const remedy = BUILTIN_IN_REMEDY[b]
    throw new UnsupportedFeatureError(
      remedy !== undefined
        ? `glsl-es300: @builtin(${b}) ${remedy}`
        : `glsl-es300: unsupported input @builtin(${b}) — no readable gl_* mapping`,
    )
  }
  return g
}
function builtinOut(b: string): string {
  const g = BUILTIN_OUT[b]
  if (!g)
    throw new UnsupportedFeatureError(
      `glsl-es300: unsupported output @builtin(${b}) — no writable gl_* mapping`,
    )
  return g
}

// gl_VertexID / gl_InstanceID are `int` in GLSL ES 3.00, but the DSL types
// vertex_index/instance_index as u32 (the WGSL convention). GLSL ES will NOT match a
// `uint` param/field against an `int` arg (overload resolution applies no implicit
// int→uint here), so the read is wrapped in the declared scalar's ctor — `uint(gl_VertexID)`.
// (Declared as i32 → no cast; vec/bool builtins like gl_FragCoord/gl_FrontFacing already match.)
const INT_INPUT_BUILTINS: ReadonlySet<string> = new Set(['vertex_index', 'instance_index'])
function builtinInRead(b: string, target: ShaderType): string {
  const g = builtinIn(b)
  if (INT_INPUT_BUILTINS.has(b) && target.kind === 'scalar' && target.scalar !== 'i32') {
    return `${glslType(target)}(${g})` // uint(gl_VertexID) / float(gl_VertexID)
  }
  return g
}

function structByName(structs: ReadonlyMap<string, StructDecl>, name: string): StructDecl {
  const s = structs.get(name)
  if (!s) throw new UnsupportedFeatureError(`glsl-es300: struct '${name}' not found in module`)
  return s
}

// Intrinsic spelling is owned by the neutral registry (core/intrinsics.ts) now —
// the divergent WGSL→GLSL mappings (atan2→atan, bitcastU32→floatBitsToUint,
// textureSample→texture, select→ternary, …) live there as the single SoT, so this
// writer no longer needs its own rename table.
/** THE GLSL ES 3.00 / WebGL2 capability table (#1670) — what this target supports and
 *  what each cap costs: a `hostFeature` the host must `gl.getExtension(...)` before
 *  pipeline creation, and (for the one cap that needs it) the `#extension` token the
 *  emitted source must carry. Coverage derives from these KEYS, so a cap is supported
 *  iff it has a row.
 *
 *  NO rows for `storageBuffer` / `compute` / `msaaTextureLoad` (WebGL2 has no SSBOs, no
 *  compute stage, no MSAA texel fetch) and none for `f16` / `subgroups` (WGSL `enable`
 *  language features with no GLSL ES 3.00 counterpart). FOUR of the five fail closed
 *  here, naming the cap; `storageBuffer` is the exception and does NOT — a storage module
 *  is REWRITTEN to a data texture (lowerStorageToDataTexture) BEFORE the gate runs, so by
 *  the time assertCaps looks there is no storage binding left to require it. The
 *  profile's emptiness for all five is the pinned invariant either way, not an oversight
 *  (extension-profile.test.ts, passes/required-caps.test.ts, enable-directives.test.ts).
 *
 *  The three HOST-side rows cost ZERO emitted bytes: WebGL2 activates them through
 *  `gl.getExtension`, and GLSL ES 3.00 has no source token for any of them (a shader
 *  writing to an RGBA32F attachment is spelled exactly like one writing to RGBA8). */
const GLSL_CAP_PROFILE: CapProfile = {
  floatRenderTarget: { hostFeature: 'EXT_color_buffer_float' },
  float32Blend: { hostFeature: 'EXT_float_blend' },
  float32Filterable: { hostFeature: 'OES_texture_float_linear' },
  // The one SOURCE-DIRECTIVE cap: the shader itself must declare it (ES 3.00 §3.4), AND
  // the host must have the extension — hence both fields.
  //
  // TRUTH IN ADVERTISING (#1670): this row buys the `#extension` MECHANISM, not
  // multiview AUTHORING. The DSL has no way to spell the other two halves — the
  // `layout(num_views = N) in;` qualifier and the `gl_ViewID_OVR` builtin — so a module
  // declaring `multiview` today emits the directive and then renders SINGLE-VIEW. It
  // exists to prove the directive path end to end; real multiview authoring is a
  // follow-up, and no consumer should read this row as "the DSL can do multiview".
  multiview: { directive: 'GL_OVR_multiview2', hostFeature: 'OVR_multiview2' },
}

/** The GLSL ES 3.00 (WebGL2) `Backend` — the second writer that proves the IR is
 *  target-neutral: it plugs GLSL spelling (types, literals, intrinsics, declaration
 *  forms) into the SAME neutral control-flow walk (`core/emit.ts`) the WGSL backend
 *  drives, rather than duplicating it. Reached through `emitGlslModule`/
 *  `emitGlslStages`, not called directly. Fails closed — relative to WGSL — on
 *  everything GLSL ES 3.00 structurally cannot express: a `@compute` entry and a
 *  multisampled (`2d-ms`) texture load (neither has a row in this backend's
 *  `GLSL_CAP_PROFILE`, so `assertCaps` rejects the module before this writer ever
 *  runs), `f16`/subgroups (WGSL `enable` features with no GLSL ES 3.00 counterpart,
 *  same no-row rejection), a standalone `sampler` type (GLSL only has the fused
 *  `sampler2D`), and a bare non-struct vertex-output entry (GLSL links inter-stage
 *  varyings by field NAME, not by `@location` the way WGSL does, so a WGSL-valid
 *  unnamed output has nothing to link against on this target). A `storage` binding
 *  is the one exception that does NOT fail: WebGL2 having no SSBO is a platform
 *  fact, so `emitGlslModule` rewrites it to a data-texture emulation before the caps
 *  gate ever sees it — though that emulation itself still fails closed on shapes it
 *  cannot cover (a `read_write` storage binding, an unsupported element type).
 *
 *  Exported from `@xgis/shader-dsl`.
 */
export const glslEs300Backend: Backend = {
  id: 'glsl-es300',
  capProfile: GLSL_CAP_PROFILE,
  typeName: glslType,
  literal: glslLit,
  intrinsic: (name, args) => spellIntrinsic('glsl', name, args),
  localLet: (name, type, init) => `${glslType(type)} ${name} = ${init}`,
  localVar: (name, type, init) =>
    init !== undefined ? `${glslType(type)} ${name} = ${init}` : `${glslType(type)} ${name}`,
  constDecl: (name, type, value) => `const ${glslType(type)} ${name} = ${value};`,
  // GLSL ES requires the case label type to MATCH the switch scrutinee: a u32 scrutinee
  // needs `${value}u` labels (an int label is a compile error), an i32/int one stays bare.
  caseLabel: (value, scrutType) =>
    scrutType.kind === 'scalar' && scrutType.scalar === 'u32' ? `${value}u` : `${value}`,
  switchHead: (scrut) => `switch (${scrut}) {`,
  // GLSL ES 3.00's `%` is INTEGER-only — a float `%` (legal WGSL trunc-mod, and what
  // the `.mod` METHOD emits) used to be spelled verbatim and die at the driver. Spell
  // WGSL's trunc-mod inline instead: `a - b·trunc(a/b)` — deliberately NOT GLSL
  // `mod()`, which is FLOOR-mod and disagrees on negative operands. Matches the CPU
  // oracle's JS `%` (also trunc-mod), so all three backends now agree.
  floatMod: (a, b) => `(${a} - ${b} * trunc(${a} / ${b}))`,
  // C-style GLSL switch falls through — each case must `break` or it leaks into the next.
  caseBreak: 'break;',
  // #1671 — emit THIS target's payload. A raw carrying only the WGSL spelling
  // still cannot lower (raw text is opaque to the IR, so there is nothing to
  // translate) — it fails closed, but the message now names the fix.
  rawStmt: (s) => {
    if (s.glsl !== undefined) return s.glsl
    // The at-least-one union guarantees a `wgsl` side here (a raw with NO payload
    // is unrepresentable), so the snippet always has something to quote. tsc
    // cannot see that — a union is not discriminable on a property whose type is
    // not a unit type — so narrow the PROPERTY with a local read rather than
    // asserting the union away; the `''` arm is unreachable by construction.
    const wgsl = s.wgsl ?? ''
    throw new UnsupportedFeatureError(
      `glsl-es300: raw Stmt carries no glsl payload (wgsl-only raw: '${wgsl.slice(0, 40)}') — supply a glsl spelling for this statement`,
    )
  },
  placeholderStmt: () => {
    throw new UnsupportedFeatureError(
      'glsl-es300: un-swapped placeholder Stmt — composer must run first',
    )
  },
  // ── Module-decl surface ──
  emitConst: (c) =>
    glslEs300Backend.constDecl(
      c.name,
      c.type,
      c.valueExpr ? emitExprNeutral(c.valueExpr, glslEs300Backend) : f32Lit(c.wgslValue),
    ),
  // A NON-uniform struct (an IO output type, or a storage element struct) emits as a
  // plain GLSL struct; the `@location`/`@builtin` field attrs are stripped here — they
  // become `in`/`out` varyings at entry-IO lowering, not struct members.
  emitStruct: (s) => {
    const fields = s.fields.map((f) => `  ${glslType(f.type)} ${f.name};`).join('\n')
    return `struct ${s.name} {\n${fields}\n};`
  },
  // A binding line that needs only the binding itself (texture/sampler → a combined
  // sampler2D uniform). A `uniform` STRUCT binding is a std140 UBO block, which needs the
  // struct fields in scope — that is assembled by emitGlslModule (which owns the struct
  // map), so the bare method fails closed to keep the offset SoT in one place. Storage
  // never reaches emit via emitGlslModule/emitGlslStages (the default data-texture
  // lowering rewrites it first); the throw here is belt-and-braces for direct backend use.
  emitBinding: (b) => {
    if (b.type.kind === 'texture' || b.type.kind === 'sampler')
      return `uniform ${glslType(b.type)} ${b.name};`
    if (b.space === 'storage')
      throw new UnsupportedFeatureError(
        'glsl-es300: storage buffer (SSBO) — GLSL ES 3.00 has no SSBO; fail-closed',
      )
    throw new UnsupportedFeatureError(
      `glsl-es300: uniform struct binding '${b.name}' — std140 UBO is assembled by emitGlslModule (needs the struct map)`,
    )
  },
  emitFunc: (f, parens) => {
    // Entry funcs are lowered to varyings + main() by emitGlslModule; a stray entry
    // reaching emitFunc means the assembly bypassed that path — fail loudly.
    if (isEntry(f))
      throw new UnsupportedFeatureError(
        `glsl-es300: entry func '${f.name}' must lower via emitGlslModule's entry path`,
      )
    if (f.attrs?.length)
      throw new UnsupportedFeatureError(
        `glsl-es300: non-entry func '${f.name}' carries stage attrs (${f.attrs.join(' ')})`,
      )
    const params = f.params.map((p) => `${glslType(p.type)} ${p.name}`).join(', ')
    return `${glslType(f.ret)} ${f.name}(${params}) {\n${emitBody(f.body, 1, glslEs300Backend, parens)}\n}`
  },
  // Same emit-time optimizer the WGSL backend runs (fixpoint: const/copy-prop,
  // const-fold, cse auto-cache, licm, dce). The pass is IR-level + backend-neutral,
  // so the WebGL2 fragment path stops recomputing CSE-able subexpressions (e.g. the
  // hillshade `terrain()` ~10x/fragment, plasma's 3-sin sum). Value-preserving
  // (oracle-validated). REQUIRES every intrinsic whose GLSL spelling diverges in
  // SIGNEDNESS from its WGSL/IR type to cast to the IR type (e.g. textureDimensions →
  // uvec2(textureSize(…))) — otherwise CSE hoisting it into a typed local is a GLSL
  // int/uint compile error. Gated by the real-WebGL2 link gate (_glsl-real-shader-link-gate).
  optimize: (m) => fixpoint(m),
  // The `#extension` header (#1670) — one `#extension <token> : require` per declared
  // cap whose PROFILE ROW carries a directive, deduped + sorted for a deterministic
  // byte order. `: require` (never `: enable`): a module that DECLARED the cap cannot
  // compile correctly without it, so a driver lacking it must say so at compileShader
  // rather than silently ignore the feature.
  //
  // Returns '' when nothing is directed — which is EVERY module today except a
  // multiview one, since the other three GLSL rows are host-side. assembleGlsl splices
  // the result at parts index 1, right after `#version 300 es` (ES 3.00 §3.4:
  // `#extension` must precede any non-preprocessor token) and BEFORE the precision
  // lines, and skips the splice entirely on '' so every other module keeps its exact
  // header bytes. It is NOT prepended by emit.ts's generic driver the way the WGSL
  // header is: `#version` must lead the file, and the GLSL path does not route through
  // that driver at all (emitGlslModule → lowerForGlsl + assembleGlsl).
  //
  // Bare lines, NO trailing separator — the one contract every backend's preamble keeps
  // (backend.ts); here the caller splices the result as ONE `parts` entry and `parts` are
  // joined with '\n', so the separator is already the assembler's.
  modulePreamble: (m) => {
    const dirs = (m.enables ?? [])
      .map((c) => GLSL_CAP_PROFILE[c]?.directive)
      .filter((d): d is string => d !== undefined)
    if (dirs.length === 0) return ''
    return [...new Set(dirs)]
      .sort()
      .map((d) => `#extension ${d} : require`)
      .join('\n')
  },
}

/** Emit a std140 UBO block for a uniform struct binding. The block tag is the STRUCT
 *  type name; the instance name is the BINDING name (the WGSL var name) — so field
 *  access `u.mvp` resolves identically across targets. Fields are declared in order;
 *  std140 default packing reproduces the wgslLayout offsets (a DETERMINISTIC layout,
 *  verified by the compile gate via UNIFORM_OFFSET). GLSL ES 3.00 has no
 *  `layout(offset=N)` member qualifier (that needs GL_ARB_enhanced_layouts / GLSL 440),
 *  so the std140 default IS the offset contract. Calling wgslLayout here binds the
 *  emitter to the same Phase-0 offset engine the host packs against (and throws on a
 *  non-host-shareable field, e.g. a texture, before producing invalid GLSL). */
function emitGlslUbo(
  b: BindingDecl,
  struct: StructDecl,
  structs: ReadonlyMap<string, StructDecl>,
): string {
  // offset oracle + host-shareable-field guard; offsets are the contract. The
  // module's struct map resolves NESTED struct fields (fp64's DF64VecN;
  // LineLayer's array<PatternSlot, 3>) — their GLSL decls are emitted by the
  // topo-sorted plain-struct pass above the UBO block.
  wgslLayout(struct, 'std140', structs)
  const fields = struct.fields.map((f) => `  ${glslType(f.type)} ${f.name};`).join('\n')
  return `layout(std140) uniform ${struct.name} {\n${fields}\n} ${b.name};`
}

/** Lower a `@vertex`/`@fragment` entry to GLSL: flatten its IO struct/params into
 *  `in`/`out` varyings + `gl_*` builtins, emit the authored body as a regular GLSL
 *  function (`<name>_impl`) over its IO structs, then synthesise a `void main()` that
 *  gathers the `in` varyings into the input struct, calls the impl, and scatters the
 *  returned output struct to the `out` varyings / `gl_*` globals.
 *
 *  GLSL ES 3.00 `layout(location=N)` RULES (the real-WebGL2 compiler enforces them):
 *  it is valid ONLY on a VERTEX INPUT (a vertex attribute) and a FRAGMENT OUTPUT (a
 *  draw buffer). An inter-stage varying — a vertex OUTPUT or a fragment INPUT — must
 *  NOT carry it (that needs ES 3.10 / GL_EXT_separate_shader_objects) and is linked
 *  BY NAME, so the vertex out and the matching fragment in share the field name
 *  verbatim. A vertex attribute is `a_`-prefixed so it never collides with a same-named
 *  varying inside the vertex shader; inter-stage varyings + fragment draw buffers keep
 *  the field name so cross-stage by-name linkage holds. */
function emitGlslEntry(
  f: FuncDecl,
  structs: ReadonlyMap<string, StructDecl>,
  parens?: ParenMode,
): string {
  // Structured-first (#763 S3): a `{ stage: 'fragment' }` decl without attrs used
  // to classify as VERTEX here (wrong varying direction / dropped entry).
  const stage: 'vertex' | 'fragment' = stageOf(f) === 'fragment' ? 'fragment' : 'vertex'
  const lines: string[] = []

  // input-varying GLSL name: a vertex attribute is `a_`-prefixed (so it can't collide with
  // a same-named vertex OUT varying); a fragment input keeps the field name (it links by
  // name to the vertex OUT of the same name).
  const inName = (n: string) => (stage === 'vertex' ? `a_${n}` : n)

  // `in` varyings: each entry param that is a struct contributes its @location fields;
  // a bare @location param contributes itself. @builtin fields read from gl_* globals.
  for (const p of f.params) {
    const fields =
      p.type.kind === 'struct'
        ? structByName(structs, p.type.name).fields.map((sf) => ({
            name: sf.name,
            type: sf.type,
            ...ioAttr(sf),
          }))
        : // A bare entry param carries its stage attr as `attr` (the `@location(n)`/`@builtin(...)`
          // string the location()/builtin() helpers emit) OR as direct location/builtin fields (raw IR).
          [{ name: p.name, type: p.type, ...ioAttr(p) }]
    for (const s of fields) {
      if (s.builtin) continue
      if (s.location === undefined)
        throw new UnsupportedFeatureError(
          `glsl-es300: entry '${f.name}' input '${s.name}' has neither @location nor @builtin`,
        )
      // location qualifier ONLY on a vertex attribute; a fragment input varying drops it.
      const qual = stage === 'vertex' ? `layout(location = ${s.location}) ` : ''
      // GLSL ES requires `flat` on an integer inter-stage varying (a fragment-IN that carries
      // an int/uint can't be interpolated). @interpolate(flat) float varyings match it (#763 P4).
      // Vertex attributes (vertex-IN) are not varyings → no flat.
      const flat =
        stage === 'fragment' && (isIntType(s.type) || s.interpolate === 'flat') ? 'flat ' : ''
      lines.push(`${qual}${flat}in ${glslType(s.type)} ${inName(s.name)};`)
    }
  }
  // `out` varyings: the return struct's @location fields (or a bare @location return).
  if (f.ret.kind !== 'struct' && f.ret.kind !== 'void' && stage === 'vertex') {
    // #763 P8 — GLSL links inter-stage varyings BY NAME (WGSL by location). A bare
    // non-struct vertex output would emit as `out T _ret`, which can never link to a
    // fragment input named anything else. Fail closed instead of emitting a shader
    // pair that compiles and renders nothing.
    throw new UnsupportedFeatureError(
      `glsl-es300: entry '${f.name}' returns a bare non-struct vertex output — GLSL links varyings by NAME; use an ioStruct so both stages share the field name`,
    )
  }
  const retFields =
    f.ret.kind === 'struct'
      ? structByName(structs, f.ret.name).fields.map((sf) => ({
          name: sf.name,
          type: sf.type,
          ...ioAttr(sf),
        }))
      : f.ret.kind === 'void'
        ? []
        : [{ name: '_ret', type: f.ret, ...parseAttrString(f.retAttr) }]
  for (const s of retFields) {
    if (s.builtin) continue
    if (s.location === undefined)
      throw new UnsupportedFeatureError(
        `glsl-es300: entry '${f.name}' output '${s.name}' has neither @location nor @builtin`,
      )
    // location qualifier ONLY on a fragment draw buffer; a vertex output varying drops it.
    const qual = stage === 'fragment' ? `layout(location = ${s.location}) ` : ''
    // `flat` on an integer VERTEX-OUT varying (matches the fragment-IN above), and on
    // @interpolate(flat) float varyings (#763 P4) — both sides derive from the same
    // structured field, so the qualifier stays link-matched. A fragment draw buffer
    // (fragment-OUT) is not interpolated → no flat.
    const flat =
      stage === 'vertex' && (isIntType(s.type) || s.interpolate === 'flat') ? 'flat ' : ''
    lines.push(`${qual}${flat}out ${glslType(s.type)} ${s.name};`)
  }

  // The authored entry, emitted as a regular GLSL function over its IO structs.
  const params = f.params.map((p) => `${glslType(p.type)} ${p.name}`).join(', ')
  const retTy = f.ret.kind === 'void' ? 'void' : glslType(f.ret)
  const impl = `${f.name}_impl`
  lines.push('')
  lines.push(`${retTy} ${impl}(${params}) {\n${emitBody(f.body, 1, glslEs300Backend, parens)}\n}`)

  // main(): gather inputs → call → scatter outputs.
  const body: string[] = []
  const args: string[] = []
  for (const p of f.params) {
    if (p.type.kind === 'struct') {
      const s = structByName(structs, p.type.name)
      body.push(`  ${glslType(p.type)} ${p.name};`)
      for (const sf of s.fields) {
        const { builtin } = ioAttr(sf)
        body.push(
          `  ${p.name}.${sf.name} = ${builtin ? builtinInRead(builtin, sf.type) : inName(sf.name)};`,
        )
      }
      args.push(p.name)
    } else {
      const bi = ioAttr(p).builtin
      args.push(bi ? builtinInRead(bi, p.type) : inName(p.name))
    }
  }
  const call = `${impl}(${args.join(', ')})`
  if (f.ret.kind === 'struct') {
    const s = structByName(structs, f.ret.name)
    body.push(`  ${glslType(f.ret)} _out = ${call};`)
    for (const sf of s.fields) {
      const { builtin, location } = ioAttr(sf)
      if (builtin) body.push(`  ${builtinOut(builtin)} = _out.${sf.name};`)
      else if (location !== undefined) body.push(`  ${sf.name} = _out.${sf.name};`)
    }
  } else if (f.ret.kind === 'void') {
    body.push(`  ${call};`)
  } else {
    const { builtin } = parseAttrString(f.retAttr)
    body.push(builtin ? `  ${builtinOut(builtin)} = ${call};` : `  _ret = ${call};`)
  }
  lines.push('')
  lines.push(`void main() {\n${body.join('\n')}\n}`)

  return lines.join('\n')
}

/** Emit a ModuleDecl as GLSL ES 3.00 (version + precision header). FED by the Phase-0
 *  reflection layout engine for uniform std140 offsets. The shared preamble
 *  (lowerForBackend) runs validate → assertCaps → optimize(lowerModule(autoVars)) — the
 *  assertCaps step fails closed (UnsupportedFeatureError) on compute/MSAA BEFORE any GLSL
 *  is produced, since neither has a row in GLSL_CAP_PROFILE; a storage binding is lowered
 *  to a data texture BEFORE that gate runs (see lowerStorageToDataTexture).
 *
 *  Assembly order: version/precision header → consts → plain structs (every struct
 *  EXCEPT a uniform/storage binding's type — those become UBO/SSBO blocks) → uniform UBO
 *  blocks + texture/sampler uniforms → helper funcs → entry funcs (each lowered to in/out
 *  varyings + a `_impl` fn over the IO structs + a `main()` that gathers/scatters them).
 *
 *  `stage` — GLSL ES is single-`main()`-per-compilation-unit (unlike WGSL's multi-entry
 *  module), so to produce a STANDALONE compilable shader pass a stage: `emitGlslModule(m,
 *  'vertex')` keeps only the `@vertex` entry (+ shared structs/uniforms/helpers) and
 *  `'fragment'` only the `@fragment` entry. Omit it (the default) for a pure-fn / whole-
 *  module string — the existing pure-math callers (LOG_DEPTH_MODULE, PROJECTION_MODULE)
 *  have no entries, so they are unaffected; a module with BOTH entries and no stage emits
 *  both main()s (a string-shape artifact, NOT a compilable unit). */
// ── storage-buffer → data-texture emulation (WebGL2 has no SSBO) ──
// GLSL ES 3.00 has no storage buffers, so a `var<storage, read> data: array<f32>`
// can't emit directly (and the caps gate fail-closes it). This GLSL-LOCAL pre-pass —
// run BEFORE the standard pipeline, on EVERY module that carries a storage binding —
// rewrites the IR so the standard pipeline never sees a storage binding:
//   • the storage `array<f32>` binding becomes a `sampler2D` (a 2D-TILED R32F DATA TEXTURE)
//   • a read `data[i]` becomes `storageFetchF32(data, i)` → texelFetch at (i % W, i / W) where
//     W = textureSize(data,0).x (the device-chosen width), so an array wider than one texture
//     row (>maxTextureSize) wraps across rows; the 1-row case is W=N → (i, 0).
// Because the rewritten module has NO storage binding, assertCaps (which keys on
// space==='storage') passes with the normal empty-caps backend — no caps loosening, so
// compute/MSAA stay fail-closed. WGSL is untouched (only emitGlslModule calls this).
//
// SCOPE: array<f32> (any size, 2D-tiled) — covers the real feat_data path (indexed / strided
// feat_data[base*STRIDE+lane] / bitcast<u32> lanes) — plus array<vecN<f32>> (the retained-icon
// tint_data path, #823): element i reads its std430 stride worth of consecutive lanes
// (vec2 = 2, vec3/vec4 = 4 — vec3 arrays pad to 16 B per std430) recombined with a vec ctor.
// array<u32> / array<i32> (#1703) close what used to be the residual here: they lower to a
// TYPED data texture (R32UI / R32I via usampler2D / isampler2D) rather than reusing the R32F
// one, because GLSL ES 3.00 §2.1.1 permits flushing denormals to zero and small integers are
// denormal f32 bit patterns — a bitcast lane may legally lose them.
// Struct-array storage layout: the std430 f32-lane offset of each field + the element stride
// (f32 lanes). A scalar field is one lane (u32 lanes are bitcast back); a vecN<f32> field is N
// consecutive lanes recombined with a vec ctor. mat / vec<u32> fields are excluded (throw on
// access). The CPU packs the struct in std430, so lane = byteOffset/4 reads the same field.
type StructField =
  { lane: number; kind: 'scalar'; isU32: boolean } | { lane: number; kind: 'vec'; n: number }
interface StructStorage {
  stride: number
  fields: Map<string, StructField>
}

// Every residual throw below is now on the DEFAULT emit path, so each message names the
// offending binding/field AND the shapes that do lower.
const SUPPORTED_STORAGE_SHAPES =
  'supported: array<f32>, array<u32>, array<i32>, array<vecN<f32>>, array<Struct of f32 / u32 (bitcast) / vecN<f32> fields>'

/** Flatten every `glsl: 'loose'` HOST-owned uniform block into one default-block uniform per
 *  member, rewriting `block.field` reads to bare `field` (#1710).
 *
 *  This is the IR-level form of the `replaceAll('block.field', 'field')` a consumer had to
 *  write over emitted TEXT, and the difference is not stylistic. Matching on the `member`
 *  node cannot touch an unrelated identifier that merely contains the same substring, it
 *  runs before the text plugins so `minify()` no longer breaks it, and the bindings it
 *  produces are real declarations — so `reflect()`, the fragment `declares` set and mangle's
 *  survivor set all describe what was actually emitted.
 *
 *  GLSL-only, and identity for every module without such a block: WGSL has one spelling for
 *  a uniform block and a host-owned group is still declared there. */
function lowerHostLooseBlocks(m: ModuleDecl): ModuleDecl {
  const loose = m.bindings.filter(
    (b) => b.type.kind === 'struct' && b.owner === 'host' && b.glsl === 'loose',
  )
  if (loose.length === 0) return m

  const structsMap = new Map(m.structs.map((s) => [s.name, s]))
  // block var name → (field name → the flattened uniform's type)
  const flat = new Map<string, Map<string, ShaderType>>()
  const flatBindings: BindingDecl[] = []
  const claimed = new Map<string, string>() // field name → the block that claimed it

  for (const b of loose) {
    const decl = structsMap.get((b.type as { name: string }).name)
    if (!decl)
      throw new UnsupportedFeatureError(
        `glsl-es300: hostBlock '${b.name}' declares struct '${(b.type as { name: string }).name}', which the module does not carry — pass it in \`structs\``,
      )
    const fields = new Map<string, ShaderType>()
    for (const f of decl.fields) {
      // Flattening puts every member into ONE namespace, so a collision here would emit two
      // `uniform` lines with the same name — a link error whose message names neither block.
      const prior = claimed.get(f.name)
      if (prior !== undefined)
        throw new UnsupportedFeatureError(
          `glsl-es300: loose hostBlock member '${f.name}' is declared by both '${prior}' and '${b.name}' — flattened members share the default block, so their names must be unique`,
        )
      claimed.set(f.name, b.name)
      fields.set(f.name, f.type)
      flatBindings.push({
        // The block's slot, carried unchanged and INERT: a GLSL default-block uniform has
        // no @group/@binding — it is set by name through glUniform*. Kept rather than
        // zeroed so each flattened member still traces back to the block it came from,
        // and deliberately never validated (see the call site: this runs after validate,
        // which would otherwise read N members at one slot as N collisions).
        group: b.group,
        binding: b.binding,
        name: f.name,
        space: 'uniform',
        type: f.type,
        owner: 'host',
        ...(b.precision ? { precision: b.precision } : {}),
      })
    }
    flat.set(b.name, fields)
  }

  const looseNames = new Set(loose.map((b) => b.name))
  const rewrite = (e: Expr): Expr =>
    mapExpr(e, (x) => {
      if (x.op !== 'member') return x
      const base = x.base
      if (base.op !== 'varref' || !looseNames.has(base.name)) return x
      const t = flat.get(base.name)!.get(x.field)
      if (t === undefined)
        throw new UnsupportedFeatureError(
          `glsl-es300: loose hostBlock '${base.name}' has no member '${x.field}'`,
        )
      return { op: 'varref', type: t, name: x.field }
    })

  return {
    ...m,
    // The block's own struct decl goes with it — nothing references the type once every read
    // is a bare uniform, and leaving it would emit a `struct` GLSL never uses.
    structs: m.structs.filter(
      (s) => !loose.some((b) => (b.type as { name: string }).name === s.name),
    ),
    bindings: [...m.bindings.filter((b) => !looseNames.has(b.name)), ...flatBindings],
    funcs: m.funcs.map((f) => ({ ...f, body: f.body.map((s) => mapStmt(s, rewrite)) })),
  }
}

function lowerStorageToDataTexture(m: ModuleDecl): ModuleDecl {
  const structsMap = new Map(m.structs.map((s) => [s.name, s]))
  const f32Names = new Set<string>() // array<f32> storage
  // array<vecN<f32>> storage — element i = `stride` consecutive f32 lanes (std430:
  // vec2 stride 2, vec3/vec4 stride 4), the first `n` recombined with a vec ctor.
  const vecStorage = new Map<string, { n: number; stride: number }>()
  const structStorage = new Map<string, StructStorage>() // array<Struct> storage
  const intStorage = new Map<string, 'u32' | 'i32'>() // array<u32> / array<i32> storage (#1703)
  for (const b of m.bindings) {
    if (b.space !== 'storage') continue
    // The emulation is GATHER-ONLY: it rewrites READS into texelFetch and has no write
    // form. Without this declaration-time gate a storage WRITE would not even fail at
    // the driver — autoVars materialises the assigned element into a local var, so the
    // store silently becomes a dead local write while the WGSL twin performs a real
    // SSBO store (silent cross-backend divergence, both green). A compute kernel's
    // read_write output is fine: lowerComputeToFragment strips it before this pass.
    if (b.access === 'read_write')
      throw new UnsupportedFeatureError(
        `glsl-es300 storage-emul: storage binding '${b.name}' is read_write — the data-texture emulation is read-only (gather); a compute kernel's output lowers via the compute→fragment path instead (declare the kernel { stage: 'compute', portable: true } — #1812 — or pass the legacy emitGlslModule({ emulateCompute: true }) opt-in), and WebGL2 has no storage-write form`,
      )
    if (b.type.kind !== 'array')
      throw new UnsupportedFeatureError(
        `glsl-es300 storage-emul: storage binding '${b.name}' is not an array — ${SUPPORTED_STORAGE_SHAPES}`,
      )
    const elem = b.type.elem
    if (elem.kind === 'scalar' && elem.scalar === 'f32') {
      f32Names.add(b.name)
      continue
    }
    // #1703 — the residual this pass used to fail closed on. A top-level array<u32> /
    // array<i32> becomes a TYPED data texture (R32UI / R32I read through usampler2D /
    // isampler2D), so element i arrives bit-exact.
    //
    // NOT the other scheme the old error message floated (carry the lanes through the
    // existing R32F texture, recover with floatBitsToUint): GLSL ES 3.00 §2.1.1 lets an
    // implementation flush ANY denormal to zero, and small integers ARE denormal f32
    // bit patterns — `1u` is 1.4e-45. That route survives on every driver measured so
    // far and is legal to break anywhere else, which is not a foundation for an
    // exact-integer array. (The struct-FIELD u32 lane further down still bitcasts
    // through R32F — pre-existing and deliberately untouched here.)
    if (elem.kind === 'scalar' && (elem.scalar === 'u32' || elem.scalar === 'i32')) {
      intStorage.set(b.name, elem.scalar)
      continue
    }
    if (elem.kind === 'vec' && elem.elem === 'f32') {
      // std430 array stride: vec2 = 8 B (2 lanes); vec3/vec4 = 16 B (4 lanes — vec3
      // rounds up to its 16 B alignment). The CPU packs against the same std430.
      vecStorage.set(b.name, { n: elem.n, stride: elem.n === 2 ? 2 : 4 })
      continue
    }
    if (elem.kind === 'struct') {
      const sd = structsMap.get(elem.name)
      if (!sd)
        throw new UnsupportedFeatureError(
          `glsl-es300 storage-emul: struct '${elem.name}' for binding '${b.name}' not in module`,
        )
      const layout = wgslLayout(sd, 'std430', structsMap) // the same std430 the host packs against
      const fields = new Map<string, StructField>()
      for (const f of sd.fields) {
        const fl = layout.fields.find((x) => x.name === f.name)!
        if (fl.offset % 4 !== 0) continue // not f32-lane-aligned → unreadable (throws on access)
        const lane = fl.offset / 4
        if (f.type.kind === 'scalar') {
          if (f.type.scalar === 'i32')
            throw new UnsupportedFeatureError(
              `glsl-es300 storage-emul: i32 field '${f.name}' of struct '${elem.name}' (binding '${b.name}') — only f32/u32 lanes supported; ${SUPPORTED_STORAGE_SHAPES}`,
            )
          fields.set(f.name, { lane, kind: 'scalar', isU32: f.type.scalar === 'u32' })
        } else if (f.type.kind === 'vec' && f.type.elem === 'f32') {
          fields.set(f.name, { lane, kind: 'vec', n: f.type.n })
        } // else mat / vec<u32> → not in map → throws on access
      }
      structStorage.set(b.name, { stride: layout.size / 4, fields })
      continue
    }
    throw new UnsupportedFeatureError(
      `glsl-es300 storage-emul: storage binding '${b.name}' has an unsupported element type — ${SUPPORTED_STORAGE_SHAPES}`,
    )
  }
  if (
    f32Names.size === 0 &&
    vecStorage.size === 0 &&
    structStorage.size === 0 &&
    intStorage.size === 0
  )
    return m
  const allNames = new Set<string>([
    ...f32Names,
    ...vecStorage.keys(),
    ...structStorage.keys(),
    ...intStorage.keys(),
  ])
  // The data texture BACKING each lowered binding. The f32 shapes keep the R32F
  // sampler2D they have always had (their emitted bytes do not move); an integer array
  // takes the matching typed texture (#1703).
  //
  // This is the half of the contract the emitted source cannot state: whoever allocates
  // the data texture must give it an internal format matching the sampler declared here
  // — R32F for sampler2D, R32UI for usampler2D, R32I for isampler2D. A mismatch does not
  // raise; the texture is merely INCOMPLETE and every texelFetch silently returns 0.
  // reflect()'s textureElem reports which one is owed.
  const dataTexT = (name: string): ShaderType => {
    const e = intStorage.get(name)
    return e === 'u32' ? texture2duT : e === 'i32' ? texture2diT : texture2dfT
  }
  // every storage binding → a data-texture uniform; same name/group/binding.
  const bindings = m.bindings.map((b): BindingDecl =>
    allNames.has(b.name) ? { ...b, space: 'uniform', type: dataTexT(b.name) } : b,
  )
  const u32lit = (value: number): Expr => ({ op: 'lit', type: u32T, value })
  const fetch = (name: string, lane: Expr): Expr => ({
    op: 'call',
    type: f32T,
    fn: 'storageFetchF32',
    args: [{ op: 'varref', type: texture2dfT, name }, lane],
  })
  // The integer twin (#1703). Result type and varref type are both derived from the
  // SAME intStorage entry that chose the binding's sampler, so the fetched type cannot
  // disagree with the type declared — a `float` result off a usampler2D would not
  // compile, and the reverse would compile and read garbage.
  const fetchInt = (name: string, lane: Expr): Expr => {
    const u = intStorage.get(name) === 'u32'
    return {
      op: 'call',
      type: u ? u32T : i32T,
      fn: u ? 'storageFetchU32' : 'storageFetchI32',
      args: [{ op: 'varref', type: u ? texture2duT : texture2diT, name }, lane],
    }
  }
  const rE = (e: Expr): Expr => {
    switch (e.op) {
      case 'member': {
        // shapes[i].field → storageFetchF32(shapes, i*STRIDE + laneOf(field)) [+ bitcast for u32].
        const b = e.base
        if (b.op === 'index' && b.base.op === 'varref' && structStorage.has(b.base.name)) {
          const ss = structStorage.get(b.base.name)!
          const fl = ss.fields.get(e.field)
          if (!fl)
            throw new UnsupportedFeatureError(
              `glsl-es300 storage-emul: field '${e.field}' of storage binding '${b.base.name}' — mat / vec<u32> / nested-struct fields not supported (only scalar + vecN<f32> lanes); ${SUPPORTED_STORAGE_SHAPES}`,
            )
          // baseLane = i*STRIDE + field-lane; a scalar reads it, a vecN reads N consecutive lanes.
          const baseLane: Expr = {
            op: 'binop',
            type: u32T,
            bop: '+',
            a: { op: 'binop', type: u32T, bop: '*', a: rE(b.idx), b: u32lit(ss.stride) },
            b: u32lit(fl.lane),
          }
          if (fl.kind === 'scalar') {
            const f = fetch(b.base.name, baseLane)
            return fl.isU32 ? { op: 'call', type: e.type, fn: 'bitcastU32', args: [f] } : f
          }
          // vecN<f32> field → vecN(fetch(base), fetch(base+1), …, fetch(base+N-1))
          const comps: Expr[] = []
          for (let k = 0; k < fl.n; k++) {
            const lane: Expr =
              k === 0 ? baseLane : { op: 'binop', type: u32T, bop: '+', a: baseLane, b: u32lit(k) }
            comps.push(fetch(b.base.name, lane))
          }
          return { op: 'construct', type: e.type, args: comps }
        }
        return { ...e, base: rE(e.base) }
      }
      case 'index':
        if (e.base.op === 'varref' && f32Names.has(e.base.name))
          return fetch(e.base.name, rE(e.idx))
        // ids[i] → storageFetchU32(ids, i) — one texel, one element, no lane math (#1703).
        if (e.base.op === 'varref' && intStorage.has(e.base.name))
          return fetchInt(e.base.name, rE(e.idx))
        if (e.base.op === 'varref' && vecStorage.has(e.base.name)) {
          // tint[i] → vecN(fetch(i*stride), …, fetch(i*stride+n-1)).
          const vs = vecStorage.get(e.base.name)!
          const baseLane: Expr = {
            op: 'binop',
            type: u32T,
            bop: '*',
            a: rE(e.idx),
            b: u32lit(vs.stride),
          }
          const comps: Expr[] = []
          for (let k = 0; k < vs.n; k++) {
            const lane: Expr =
              k === 0 ? baseLane : { op: 'binop', type: u32T, bop: '+', a: baseLane, b: u32lit(k) }
            comps.push(fetch(e.base.name, lane))
          }
          return { op: 'construct', type: e.type, args: comps }
        }
        if (e.base.op === 'varref' && structStorage.has(e.base.name))
          throw new UnsupportedFeatureError(
            `glsl-es300 storage-emul: storage struct element '${e.base.name}[i]' used without a .field access — a whole-struct element read has no lane; read one field at a time (e.g. ${e.base.name}[i].someField)`,
          )
        return { ...e, base: rE(e.base), idx: rE(e.idx) }
      case 'binop':
        return { ...e, a: rE(e.a), b: rE(e.b) }
      case 'compare':
        return { ...e, a: rE(e.a), b: rE(e.b) }
      case 'logical':
        return { ...e, a: rE(e.a), b: rE(e.b) }
      case 'unop':
        return { ...e, a: rE(e.a) }
      case 'call':
        return { ...e, args: e.args.map(rE) }
      case 'construct':
        return { ...e, args: e.args.map(rE) }
      case 'select':
        return { ...e, cond: rE(e.cond), ifTrue: rE(e.ifTrue), ifFalse: rE(e.ifFalse) }
      case 'matchExpr':
        return {
          ...e,
          scrutinee: rE(e.scrutinee),
          cases: e.cases.map(([v, x]) => [v, rE(x)] as const),
          default: rE(e.default),
        }
      default:
        return e // lit / constref / param / varref
    }
  }
  const rS = (s: Stmt): Stmt => {
    switch (s.s) {
      case 'let':
        return { ...s, expr: rE(s.expr) }
      case 'var':
        return { ...s, init: s.init !== undefined ? rE(s.init) : undefined }
      case 'assign':
        return { ...s, target: rE(s.target), expr: rE(s.expr) }
      case 'assignOp':
        return { ...s, target: rE(s.target), expr: rE(s.expr) }
      case 'return':
        return s.expr !== undefined ? { ...s, expr: rE(s.expr) } : s
      case 'if':
        return {
          ...s,
          arms: s.arms.map((a) => ({ cond: rE(a.cond), body: a.body.map(rS) })),
          elseBody: s.elseBody?.map(rS),
        }
      case 'for':
        return {
          ...s,
          init: rS(s.init),
          cond: rE(s.cond),
          update: rS(s.update),
          body: s.body.map(rS),
        }
      case 'switch':
        return {
          ...s,
          scrut: rE(s.scrut),
          cases: s.cases.map((c) => ({ value: c.value, body: c.body.map(rS) })),
          defaultBody: s.defaultBody?.map(rS),
        }
      default:
        return s
    }
  }
  return { ...m, bindings, funcs: m.funcs.map((f) => ({ ...f, body: f.body.map(rS) })) }
}

// ── compute → fragment-GPGPU lowering (WebGL2 ES 3.00 has no compute) ──
// A GLSL-LOCAL IR→IR pre-pass — sibling of lowerStorageToDataTexture — run BEFORE it
// (and before the standard pipeline) ONLY under emitGlslModule({emulateCompute}). It
// rewrites a GATHER-ONLY @compute kernel into a @fragment GPGPU pass:
//   • @compute @workgroup_size(N) entry → @fragment entry (N is perf-only on WebGPU,
//     dropped — the output texel grid carries the dispatch).
//   • the @builtin(global_invocation_id) param → removed; an @builtin(position)
//     param (xgis_frag_pos → gl_FragCoord) injected. gid.x (the linear invocation index)
//     → u32(floor(gl_FragCoord.x)) + u32(floor(gl_FragCoord.y)) * u_count.y, where
//     u_count.y = the output-texture width W_out (packed by the M2c runtime, same 2D
//     tiling as the input read texture).
//   • out[fid] = E (the SOLE read_write-storage write, at the invocation index) →
//     `return E;` with ret = u32T @location(0) → a `layout(location=0) out uint`
//     R32UI draw buffer, bit-exact for the packed pack4x8unorm(color) u32.
//   • the per-fid bounds guard's exprless `return;` → `discard;` (padding texels in the
//     last partial row write nothing).
//   • the read_write storage binding is REMOVED; the read storage binding (feat_data)
//     STAYS for lowerStorageToDataTexture (runs next) to convert to a sampler2D.
// Because the rewritten module has NO @compute attr and NO storage write binding,
// requiredCaps drops 'compute' (+ the storage cap once lowerStorageToDataTexture runs),
// so assertCaps passes with the normal empty-caps backend — no caps loosening, WGSL
// untouched. FAIL-CLOSED (operationalizes the gather-only invariant, not trusted): a
// scatter (write index != gid), >1 output write, or a gid use other than `.x` throws.
/** Rewrite a gather-only `@compute` module into a fragment-GPGPU one, per the mapping
 *  documented in the comment block above.
 *
 *  @internal Reachable from the package entry only through `index.ts`'s star re-export of
 *  this backend module, and called by nothing outside it. The supported way to ask for this
 *  lowering is the {@link GlslEmitOptions.emulateCompute} emit option, which runs it as part
 *  of a complete emit; invoking the pass directly hands back a half-lowered module whose
 *  storage bindings still need `lowerStorageToDataTexture`. Un-export is tracked by #1697.
 *
 *  @throws {UnsupportedFeatureError} on anything outside the gather-only shape — a scatter
 *  write, more than one output write, or a `global_invocation_id` use other than `.x`. That
 *  is deliberate: the invariant is operationalized, never trusted.
 *
 *  @throws {ShaderDslError} `SD0111` instead of the above when the entry is
 *  `portable`-declared (#1812): the tier's shape has ONE authority
 *  (`passes/portable-kernel.ts`), so a declared kernel is checked there and reports EVERY
 *  violation with its remedy, rather than the first ad-hoc throw this pass happens to reach.
 *  The undeclared / `emulateCompute` path keeps the throws below verbatim. */
export function lowerComputeToFragment(m: ModuleDecl): ModuleDecl {
  const entry = m.funcs.find(
    (f) => f.stage === 'compute' || f.attrs?.some((a) => a.startsWith('@compute')),
  )
  if (!entry)
    throw new UnsupportedFeatureError('glsl-es300 compute-emul: no @compute entry in module')
  // A portable-declared kernel is gated by the tier analyzer FIRST — the single authority for
  // the shape, shared with the `portable-kernel` lint rule so both writers report the same
  // sentences. The ad-hoc throws below stay as they are for the undeclared path (their exact
  // messages are pinned by the M2a tests).
  if (isPortableComputeEntry(entry)) {
    const tier = analyzePortableKernel(m, entry)
    if (!tier.ok) throw dslError('SD0111', tier.violations.join('; '))
  }
  const gid = entry.params.find((p) => ioAttr(p).builtin === 'global_invocation_id')
  if (!gid)
    throw new UnsupportedFeatureError(
      'glsl-es300 compute-emul: @compute entry has no @builtin(global_invocation_id) param',
    )
  const outBinding = m.bindings.find((b) => b.space === 'storage' && b.access === 'read_write')
  if (!outBinding)
    throw new UnsupportedFeatureError(
      'glsl-es300 compute-emul: no read_write storage output binding to map to the fragment colour output',
    )
  const uCount = m.bindings.find((b) => b.space === 'uniform')
  if (!uCount)
    throw new UnsupportedFeatureError(
      'glsl-es300 compute-emul: no uniform binding (u_count) to source the output-row width from',
    )

  const isGidX = (e: Expr): boolean =>
    e.op === 'member' && e.field === 'x' && e.base.op === 'param' && e.base.name === gid.name

  // the linear texel index from gl_FragCoord (pixel-center → floor is exact in range).
  const fragPos: Expr = { op: 'param', type: vec4fT, name: 'xgis_frag_pos' }
  const u32floor = (f: 'x' | 'y'): Expr => ({
    op: 'call',
    type: u32T,
    fn: 'u32',
    args: [
      {
        op: 'call',
        type: f32T,
        fn: 'floor',
        args: [{ op: 'member', type: f32T, base: fragPos, field: f }],
      },
    ],
  })
  const width: Expr = {
    op: 'member',
    type: u32T,
    base: { op: 'varref', type: uCount.type, name: uCount.name },
    field: 'y',
  }
  const fidExpr: Expr = {
    op: 'binop',
    type: u32T,
    bop: '+',
    a: u32floor('x'),
    b: { op: 'binop', type: u32T, bop: '*', a: u32floor('y'), b: width },
  }

  // Expr rewrite: gid.x → fidExpr; a bare gid param ref (gid.y/.z or whole vec) is a
  // non-gather use → fail-closed; everything else recurses (exhaustive, mirrors rE in
  // lowerStorageToDataTexture).
  const rE = (e: Expr): Expr => {
    if (isGidX(e)) return fidExpr
    if (e.op === 'param' && e.name === gid.name)
      throw new UnsupportedFeatureError(
        `glsl-es300 compute-emul: global_invocation_id used other than '.x' — only a 1-D linear invocation index is supported`,
      )
    switch (e.op) {
      case 'member':
        return { ...e, base: rE(e.base) }
      case 'index':
        return { ...e, base: rE(e.base), idx: rE(e.idx) }
      case 'binop':
        return { ...e, a: rE(e.a), b: rE(e.b) }
      case 'compare':
        return { ...e, a: rE(e.a), b: rE(e.b) }
      case 'logical':
        return { ...e, a: rE(e.a), b: rE(e.b) }
      case 'unop':
        return { ...e, a: rE(e.a) }
      case 'call':
        return { ...e, args: e.args.map(rE) }
      case 'construct':
        return { ...e, args: e.args.map(rE) }
      case 'select':
        return { ...e, cond: rE(e.cond), ifTrue: rE(e.ifTrue), ifFalse: rE(e.ifFalse) }
      case 'matchExpr':
        return {
          ...e,
          scrutinee: rE(e.scrutinee),
          cases: e.cases.map(([v, x]) => [v, rE(x)] as const),
          default: rE(e.default),
        }
      default:
        return e // lit / constref / param(non-gid) / varref
    }
  }

  let writes = 0
  const rS = (s: Stmt): Stmt => {
    // the SOLE read_write-storage write `out[gid.x] = E` → `return E` (R32UI draw buffer).
    if (
      s.s === 'assign' &&
      s.target.op === 'index' &&
      s.target.base.op === 'varref' &&
      s.target.base.name === outBinding.name
    ) {
      writes++
      if (!isGidX(s.target.idx))
        throw new UnsupportedFeatureError(
          `glsl-es300 compute-emul: output write '${outBinding.name}[…]' is not at the invocation index (scatter / non-gather kernel unsupported)`,
        )
      return { s: 'return', expr: rE(s.expr) }
    }
    switch (s.s) {
      case 'let':
        return { ...s, expr: rE(s.expr) }
      case 'var':
        return { ...s, init: s.init !== undefined ? rE(s.init) : undefined }
      case 'assign':
        return { ...s, target: rE(s.target), expr: rE(s.expr) }
      case 'assignOp':
        return { ...s, target: rE(s.target), expr: rE(s.expr) }
      case 'return':
        return s.expr !== undefined ? { ...s, expr: rE(s.expr) } : { s: 'discard' } // bounds-guard early-out → discard
      case 'if':
        return {
          ...s,
          arms: s.arms.map((a) => ({ cond: rE(a.cond), body: a.body.map(rS) })),
          elseBody: s.elseBody?.map(rS),
        }
      case 'for':
        return {
          ...s,
          init: rS(s.init),
          cond: rE(s.cond),
          update: rS(s.update),
          body: s.body.map(rS),
        }
      case 'switch':
        return {
          ...s,
          scrut: rE(s.scrut),
          cases: s.cases.map((c) => ({ value: c.value, body: c.body.map(rS) })),
          defaultBody: s.defaultBody?.map(rS),
        }
      default:
        return s // discard
    }
  }

  const newBody = entry.body.map(rS)
  if (writes !== 1)
    throw new UnsupportedFeatureError(
      `glsl-es300 compute-emul: expected exactly ONE output write to '${outBinding.name}', found ${writes} (only a gather-only single-output kernel maps to fragment-GPGPU)`,
    )

  const rewritten: FuncDecl = {
    ...entry,
    attrs: ['@fragment'],
    // The STRUCTURED stage must move with the attrs (#740 R3): stageOf reads it first, so a
    // structured-authored compute entry (every fn()-authored one, hence every portable one)
    // would otherwise stay stage: 'compute' behind an '@fragment' attr — and assembleGlsl's
    // stage filter, which goes through stageOf, would find no fragment entry to spell.
    // Byte-neutral for the attrs-only M2a fixture: stageOf already answered 'fragment' there.
    stage: 'fragment',
    workgroupSize: undefined,
    // The tier declaration is compute-only and this entry is no longer a compute entry, so it
    // does not survive the rewrite — which is also what keeps the portable-kernel lint rule
    // (CORE, so it runs again on this lowered module) from analysing a fragment entry.
    portable: undefined,
    params: [
      { name: 'xgis_frag_pos', type: vec4fT, builtin: 'position' },
      ...entry.params.filter((p) => p !== gid),
    ],
    ret: u32T,
    retAttr: '@location(0)',
    body: newBody,
  }
  return {
    ...m,
    bindings: m.bindings.filter((b) => b !== outBinding),
    funcs: m.funcs.map((f) => (f === entry ? rewritten : f)),
  }
}

// ── Per-stage emit scope (stage reachability) ──
//
// emitGlslModule compiles ONE stage per call, but the lowered module carries
// BOTH stages' functions, bindings, and structs — WGSL emits one module for
// all stages (Tint dead-strips per entry), so nothing upstream trims per
// stage. Emitting everything into every stage leaks fragment-only machinery
// into the vertex shader (e.g. the whole df64 helper set + the `_fp64` guard
// sampler when f64 is used only in fragment). Scope each stage's emit to what
// its entries transitively reach:
//   • fns      — call-graph closure from the stage's entries
//   • bindings — varref'd by a reachable fn (a binding reference IS a varref;
//                a same-named local only over-keeps), or named textually by a
//                called intrinsic's spelling (INTRINSIC_BINDING_REFS —
//                f64Guard's zero-arg fetch from `_fp64`)
//   • structs  — spelled by a reachable fn (signature / var-decl / expr
//                types), plus every kept binding's block struct and every
//                module const's type (consts are NOT stage-filtered), closed
//                over nested field types
// Returns null → no filtering (the historical emit-everything behavior) when
// the scope is not computable: a `raw` stmt (textual references the IR walk
// cannot see) or no entry for the selected stage (helper-only emit paths).
function stageScope(
  m: ModuleDecl,
  entries: readonly FuncDecl[],
): { fns: Set<string>; bindings: Set<string>; structs: Set<string> } | null {
  if (entries.length === 0) return null
  if (m.funcs.some((f) => bodyHasRaw(f.body))) return null

  const byName = new Map(m.funcs.map((f) => [f.name, f]))
  const refs = emptyRefSet()
  const fns = new Set(entries.map((f) => f.name))
  const stack = [...entries]
  while (stack.length > 0) {
    collectFnRefs(stack.pop()!, refs)
    for (const name of refs.calls) {
      const f = byName.get(name)
      if (f && !fns.has(name)) {
        fns.add(name)
        stack.push(f)
      }
    }
  }

  const bindings = new Set<string>()
  for (const b of m.bindings) if (refs.vars.has(b.name)) bindings.add(b.name)
  for (const call of refs.calls)
    for (const bound of INTRINSIC_BINDING_REFS[call] ?? []) bindings.add(bound)

  const structs = new Set(refs.structs)
  for (const b of m.bindings) if (bindings.has(b.name)) typeStructNames(b.type, structs)
  for (const c of m.consts) typeStructNames(c.type, structs)
  const structByNameMap = new Map(m.structs.map((s) => [s.name, s]))
  const work = [...structs]
  while (work.length > 0) {
    const s = structByNameMap.get(work.pop()!)
    if (!s) continue
    const fieldStructs = new Set<string>()
    for (const f of s.fields) typeStructNames(f.type, fieldStructs)
    for (const n of fieldStructs)
      if (!structs.has(n)) {
        structs.add(n)
        work.push(n)
      }
  }

  return { fns, bindings, structs }
}

/** The `opts` bag accepted by this backend's emit entry points, extending the neutral
 *  {@link EmitOptions} with the three knobs that exist only for GLSL ES 3.00.
 *
 *  Each one is here because the target lacks something WGSL has: no compute stage
 *  (`emulateCompute`), no driver-side specialization constants (`overrideValues`), and no
 *  implicit precision (`floatPrecision`). All three are BUILD-TIME — an emit option, never a
 *  runtime device probe — so emitted source stays cacheable under a key derived from the
 *  options, and every default is byte-neutral: omitting the bag entirely reproduces the
 *  bytes emitted before any of these options existed. */
export interface GlslEmitOptions extends EmitOptions {
  /** Lower a GATHER-ONLY @compute kernel to a fragment-GPGPU pass (see
   *  lowerComputeToFragment). OPT-IN, unlike the storage lowering: it rewrites the
   *  compute entry into a fragment entry, so the host must dispatch a fullscreen DRAW
   *  into an R32UI target instead of a compute dispatch — a host contract, not a
   *  platform fact. Implies the storage lowering for the surviving read bindings.
   *
   *  @deprecated SUPERSEDED by the PORTABLE KERNEL TIER (#1812) — declare the kernel
   *  `fn(…, { stage: 'compute', portable: true })` and this lowering runs with no emit option
   *  at all. The paragraph above is the recorded reason auto-lowering was rejected, and it is
   *  kept because it is still correct: the rewrite changes the HOST contract, so it must never
   *  be a silent platform default. The declaration ANSWERS that objection rather than ignoring
   *  it — the choice moves from the emit call site (a flag a caller can flip without the
   *  kernel author's knowledge) to the AUTHORING site, where the kernel's shape is decided and
   *  where the tier's gather-only contract can be validated at every emit on both writers
   *  (SD0111); and the RHI layer that owns the host contract already speaks it
   *  (`rhi-webgl2/src/compute-webgl2.ts` dispatches compute as a fullscreen draw into an R32UI
   *  target). This flag remains as the synonym for UNDECLARED kernels — same code path, same
   *  bytes — so nothing that passes it has to change. */
  emulateCompute?: boolean
  /** #923 host specialization — pin `override` values for THIS emit. GLSL ES 3.00
   *  has no driver-side spec constants, so a specialized variant is a re-emit: each
   *  named override becomes a hard `#define NAME <value>` (spelled via the backend
   *  `literal()`, so a u32 gets its `u` suffix and an f32 its `.0`) emitted AFTER the
   *  `#version`/precision preamble — never PREPENDED, which GLSL rejects (`#version`
   *  must lead the source). Un-named overrides keep their `#ifndef` default. The
   *  values derive from `reflect().overrides` (name→chosen value); the WGSL twin is
   *  `createRenderPipeline({ constants })`. */
  overrideValues?: Readonly<Record<string, number | boolean>>
  /** #1673 — default FLOAT precision qualifier for this emit. `'highp'` (the default)
   *  is BYTE-NEUTRAL: an emit that omits this option is byte-identical to every emit
   *  produced before the option existed.
   *
   *  WHY: a mobile GPU pays real bandwidth and power for highp arithmetic and highp
   *  varyings where mediump suffices, and the precision qualifier is the only lever
   *  GLSL ES gives for it. BUILD-TIME by design — an emit option, not a runtime device
   *  probe: `map/src/shaders/emit/shader-emit-request.ts` caches emitted source under a
   *  `shaderRequestKey` that has NO precision component, so a runtime-varying precision
   *  would serve a mediump program to a highp request (second-authority drift).
   *
   *  SCOPE — this spells the `precision <p> float;` line and NOTHING else:
   *  - `precision highp int;` is LOAD-BEARING (storage-emulation index math, bitcast
   *    lanes) and is never qualified by this option. MapLibre sets no int precision at
   *    all; we keep ours pinned at highp.
   *  - The #1651/#1703 `precision highp <sampler type>;` lines are likewise untouched.
   *  - It is a WHOLE-STAGE default, so it covers positions and coordinates too. mediump
   *    is ~fp16: ~3 decimal digits over a ±65504 range, far short of what a projected
   *    map coordinate needs — f32 ALREADY collapses at deep zoom, which is the entire
   *    reason the df64 emulation in `core/fp64` exists (AUTHORING.md §7). Use this ONLY
   *    for fragment-colour-class shaders whose output is a bounded, low-dynamic-range
   *    colour; never for a stage computing a position, a tile/world coordinate, or a
   *    df64 lane.
   *
   *  NOT verifiable in CI beyond compile validity + header shape: the CI rasterizer
   *  ADVERTISES mediump as 10-bit yet BEHAVES as f32 (computed at >=f32 or the probe
   *  form reassociated — indistinguishable from outside), so no pixel gate can
   *  distinguish the two emits (census: `playground/e2e/_glsl-compile-gate.spec.ts`). */
  floatPrecision?: 'highp' | 'mediump'
}

/** The IR half of a GLSL emit: the pre-lowerings, the shared backend pipeline
 *  (validate → autoVars → lowerModule → fp64Lower → the optimizer FIXPOINT) and the
 *  IR plugins. Everything here is stage-INDEPENDENT, which is why it is split from the
 *  spelling half: a host compiling both stages of one module used to pay this twice,
 *  and the fixpoint over a big fragment fn dominates it (hillshade multidirectional:
 *  ~770 ms per emit, so the `vs_tile` re-emit alone cost as much as the fragment even
 *  though the vertex fn is shared with raster's 36 ms module). `emitGlslStages` pays
 *  it once. Pure: takes an authored module, returns a lowered one. */
function lowerForGlsl(m: ModuleDecl, opts?: GlslEmitOptions): ModuleDecl {
  // autoVars BEFORE lowerModule (inside lowerForBackend), same order as the WGSL backend /
  // CPU oracle — materialising assigned plain-value bindings into real vars is BACKEND-NEUTRAL.
  // The storage→data-texture emulation runs FIRST, and DEFAULT-ON whenever the module
  // carries a storage binding (WebGL2 has no SSBO — a platform fact, not a caller choice),
  // so the rewritten module carries none (assertCaps then passes with the normal
  // empty-caps backend). A module WITHOUT a storage binding takes the untouched path.
  // The compute→fragment lowering runs FIRST (strips the @compute attr + the
  // read_write `out_color` binding, which lowerStorageToDataTexture would throw on),
  // then storage→data-texture converts the remaining `feat_data` read. It is still never a
  // silent platform default — the rewrite changes the HOST contract (draw, not dispatch) —
  // but the choice now has TWO spellings: the DECLARATION `portable: true` on the compute
  // entry (#1812; made at the authoring site, gated by the tier analyzer at every emit on
  // both writers) and the older `emulateCompute` emit option, which supersedes to it and
  // stays as the synonym for undeclared kernels. Same code path, same bytes.
  // autoVars must run BEFORE any cloning IR→IR pre-pass: it materialises
  // assigned plain-value bindings by Expr OBJECT IDENTITY (see auto-vars.ts),
  // and the storage/compute lowerings clone expression trees — running them
  // first orphans every read of an assigned temp from its assignments (the
  // emitted GLSL then reads the CSE'd INITIALIZER forever; the #834 M5 line
  // twin returned position = vec4(0) this way). autoVars is a no-op on an
  // already-materialised module, so lowerForBackend's own autoVars stays.
  const hasStorage = m.bindings.some((b) => b.space === 'storage')
  // An UNDECLARED @compute module without {emulateCompute} keeps the old fail-close
  // (assertCaps naming 'compute') — default-lowering its storage first would replace that
  // diagnosis with a storage-shape error pointing away from the actual fix (declare the
  // kernel portable, or pass the opt-in). A PORTABLE-declared entry takes the lowering with
  // no option: that is the tier's whole contract (#1812).
  const hasComputeEntry = m.funcs.some(
    (f) => f.stage === 'compute' || f.attrs?.some((a) => a.startsWith('@compute')),
  )
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- this IS the deprecated flag's implementation; reading it here is what keeps it working as the undeclared-kernel synonym.
  const src = opts?.emulateCompute
    ? lowerStorageToDataTexture(lowerComputeToFragment(autoVars(m)))
    : hasStorage && !hasComputeEntry
      ? lowerStorageToDataTexture(autoVars(m))
      : m
  // GLSL-local: rename any param/var identifier colliding with a GLSL reserved word
  // (e.g. an entry param `input` / `in`) — does NOT affect the WGSL backend.
  // The transformIR plugins (production tooling — emit-prod's mangle) run LAST in
  // the IR chain; their contract requires determinism on the lowered module, so
  // the vertex and fragment emits (separate calls over the same module) agree on
  // every shared transformed name.
  //
  // Loose host blocks (#1710) flatten AFTER lowerForBackend and BEFORE the plugins.
  // After, because lowerForBackend validates, and the flattened members all carry their
  // block's slot: a default-block uniform HAS no @group/@binding, so validating them as
  // real slots reports a collision that does not exist on the target. Validation must see
  // the module as authored — one block at one slot, which is exactly what WGSL emits and
  // what `reflect()` reports. Before the plugins, so mangle sees the flattened bindings
  // and its survivor set keeps every host-owned name.
  return applyIRPlugins(
    lowerHostLooseBlocks(
      sanitizeReservedIdents(lowerForBackend(src, glslEs300Backend, undefined, opts?.fp64Flavor)),
    ),
    opts,
  )
}

/** The SPELLING half: turn an already-lowered module into one stage's GLSL text.
 *  Reads `lowered` without mutating it, so the same lowered module can be spelled for
 *  both stages (emitGlslStages). */
function assembleGlsl(
  /** The already-computed `#extension` header (#1670) — bare directive lines, '' when
   *  the module directs nothing. Passed in as a STRING rather than as a second
   *  `ModuleDecl` to derive it from: the authored/lowered pair were adjacent params of
   *  the same type, one silent swap away from a header built from the wrong module. Its
   *  source is `enables`, an AUTHORING-level declaration, so every call site computes it
   *  from the authored module (deriving it from `lowered` would make the emitted header
   *  depend on every lowering pass preserving an authoring field, and would leave the
   *  WGSL driver — which reads the authored module, emit.ts — and this one as two
   *  siblings that must agree, the divergence archetype this repo pays for). */
  extHeader: string,
  lowered: ModuleDecl,
  stage: 'vertex' | 'fragment' | undefined,
  opts?: GlslEmitOptions,
  /** Name of the single entry to spell for this stage. A module may declare SEVERAL
   *  entries for one stage (fs_fill / fs_fill_pattern, fs_line / fs_line_max / …) and
   *  GLSL allows exactly one `main` per stage, so the caller must say which. Consumers
   *  used to express that by deleting the other entries from the module BEFORE lowering,
   *  which forced a separate lowering per stage; selecting here instead lets both stages
   *  share one (see emitGlslStages). */
  keepEntry?: string,
  /** #1711 — omit the stage entry points, for a DECLARATIONS-ONLY fragment a host
   *  composes into a program it owns. The entries are still computed (they decide the
   *  stage scope, so dropping them earlier would change which helpers and bindings
   *  survive) and are reported to the caller; only their spelling is withheld. */
  omitEntries?: boolean,
): GlslAssembly {
  const structs = new Map(lowered.structs.map((s) => [s.name, s]))

  // Stage filter through the shared predicate (#763 S3) — the old attr-string
  // match silently DROPPED a structured-only entry from its own stage's emit.
  const entries = lowered.funcs.filter(
    (f) =>
      isEntry(f) &&
      (stage === undefined || stageOf(f) === stage) &&
      (keepEntry === undefined || f.name === keepEntry),
  )
  // Stage-scoped emit (see stageScope) — only when compiling ONE stage; the
  // whole-module form (stage === undefined, a string-shape artifact used by
  // tests) keeps the emit-everything contract. null = scope not computable.
  const scope = stage === undefined ? null : stageScope(lowered, entries)
  const helpers = lowered.funcs.filter(
    (f) => !isEntry(f) && (scope === null || scope.fns.has(f.name)),
  )

  // A struct consumed as a uniform/storage BINDING type becomes a UBO/SSBO block, NOT a
  // GLSL `struct` decl — reusing its name for both a `struct` and a `uniform <Name> {…}`
  // block is a redeclaration error. EVERY OTHER struct (IO in/out + storage-element +
  // nested + helper-fn arg) IS emitted as a plain GLSL struct: the entry's `_impl` fn
  // signature references the IO struct types, and storage-element structs are read field-
  // wise — both need a real `struct` decl.
  const bindingStructNames = new Set<string>()
  for (const b of lowered.bindings)
    if (b.type.kind === 'struct') bindingStructNames.add(b.type.name)

  // The FLOAT line is the only one `opts.floatPrecision` (#1673) spells; absent, it is
  // 'highp' and the header is byte-identical to every pre-#1673 emit.
  //
  // `precision highp int;` too: a GLSL ES 3.00 FRAGMENT shader has NO default int
  // precision, so a uint/int varying or expression there is a compile error without it.
  // That line is deliberately NOT under the knob — the storage→data-texture emulation's
  // index math and the bitcast lanes need full int range, so lowering it would turn a
  // bandwidth optimisation into a correctness bug.
  //
  // Every sampler type EXCEPT `sampler2D` needs its OWN line (#1651, #1703): GLSL ES
  // 3.00 §4.5.4 predeclares default precisions for `sampler2D` / `samplerCube` ONLY, so
  // a `uniform sampler2DArray` / `usampler2D` / `isampler2DArray` without a qualifier is
  // a compile error — and `precision highp float;` does not cover it.
  //
  // DERIVED from glslType() rather than a second spelling table: a hand-listed set is
  // exactly the two-authorities drift that lets a new texture shape emit a precision
  // line naming a type it never declares (or worse, declare one with no line and fail
  // only on a real GPU). '2d-ms' is skipped because it never reaches emit — the caps
  // gate fails it closed first, and glslType() throws on it.
  //
  // Emitted only for the shapes THIS stage declares, so every module without one keeps
  // its byte-identical header; sorted so the header is deterministic.
  const samplerPrecisions = [
    ...new Set(
      lowered.bindings
        .filter(
          (b) =>
            b.type.kind === 'texture' &&
            b.type.dim !== '2d-ms' &&
            (scope === null || scope.bindings.has(b.name)),
        )
        .map((b) => glslType(b.type)),
    ),
  ]
    .filter((s) => s !== 'sampler2D')
    .sort()
  // #1670 — the `#extension … : require` directives this module's declared caps need
  // (computed by the caller from the AUTHORED module), SPLICED between `#version` and the
  // first precision line. That slot is not a style choice: GLSL ES 3.00 §3.4 requires an
  // `#extension` directive to precede any non-preprocessor token, and `#version` must
  // itself lead the source. '' (every module whose caps are host-side, i.e. all of them
  // today except a multiview one) splices NOTHING, so the header keeps its exact bytes —
  // the byte-neutral-when-unused shape of the #1651 sampler2DArray line above.
  //
  // Split out rather than pushed onto `parts` (#1711): these lines are what a host that
  // owns the program supplies itself, so a declarations-only fragment must hand them back
  // as DATA instead of concatenating them into source the consumer then has to strip. A
  // regex over the emitted text cannot do it safely — `#extension` sits between `#version`
  // and the precision lines exactly when a capability directs one, so a
  // strip-`#version`-then-precision pattern silently keeps the whole block on those
  // modules and removes it on every other one.
  const preamble: string[] = [
    '#version 300 es',
    ...(extHeader ? [extHeader] : []),
    `precision ${opts?.floatPrecision ?? 'highp'} float;`,
    'precision highp int;',
    ...samplerPrecisions.map((s) => `precision highp ${s};`),
  ]
  const parts: string[] = []

  // #923 — specialization constants. GLSL ES 3.00 has no `override`, so the portable
  // equivalent is the PREPROCESSOR, emitted HERE (after the `#version`/precision
  // preamble — `#version` MUST lead the source, so a host `#define` can NOT be
  // prepended). Each override becomes a `#define` whose default is guarded by `#ifndef`,
  // so the module compiles standalone. A host specializes a variant by RE-EMITTING with
  // `opts.overrideValues` (the GLSL twin of WGSL `createRenderPipeline({ constants })`):
  // a pinned name emits a hard `#define NAME <value>` — value spelled through the
  // backend `literal()`, so a u32 keeps its `u` suffix and an f32 its `.0` (a raw
  // JS-stringified int would break `NAME > 1u` on a uint override) — while an un-pinned
  // name keeps its `#ifndef` default. A branch guarded by the macro (`if (NAME > 1.0)`)
  // is dead-code-eliminated by the GLSL COMPILER per program — the runtime-`if` form
  // (not `#if`) because the GLSL preprocessor's `#if` evaluates INTEGER constant
  // expressions only and cannot handle a float/bool override. The value manifest is
  // recoverable from reflect().overrides, so a host derives each permutation mechanically.
  if (lowered.overrides?.length)
    parts.push(
      lowered.overrides
        .map((o) => {
          const pinned = opts?.overrideValues?.[o.name]
          return pinned !== undefined
            ? `#define ${o.name} ${glslEs300Backend.literal(pinned, o.type)}`
            : `#ifndef ${o.name}\n#define ${o.name} ${glslEs300Backend.literal(o.default, o.type)}\n#endif`
        })
        .join('\n'),
    )

  if (lowered.consts.length)
    parts.push(lowered.consts.map((c) => glslEs300Backend.emitConst(c)).join('\n'))

  // Topologically sorted (#763 P5): GLSL has no struct forward-declaration, so a
  // nested struct must be DEFINED before the struct that embeds it. WGSL accepts
  // any order; helper fns got prototypes in #745 — structs get a topo sort.
  const plainStructs = topoSortStructs(
    lowered.structs.filter(
      (s) => !bindingStructNames.has(s.name) && (scope === null || scope.structs.has(s.name)),
    ),
  )
  if (plainStructs.length)
    parts.push(plainStructs.map((s) => glslEs300Backend.emitStruct(s)).join('\n\n'))

  // Uniform UBO blocks (std140, reflection-fed) + texture/sampler uniforms.
  const bindingLines: string[] = []
  for (const b of lowered.bindings) {
    // Stage-scoped: a binding no reachable fn references emits nothing in this
    // stage (the other stage still declares it; GL uniform lookups link by name
    // across the program, so hosts bind unchanged).
    if (scope !== null && !scope.bindings.has(b.name)) continue
    if (b.type.kind === 'texture') bindingLines.push(`uniform ${glslType(b.type)} ${b.name};`)
    // A standalone WGSL sampler binding is FUSED into the texture's combined
    // sampler2D (textureSample(tex,samp,uv) → texture(tex,uv)), so it emits no
    // separate GLSL uniform. The host reflection maps the texture binding to a
    // texture unit and drops the sampler binding to match.
    else if (b.type.kind === 'sampler') {
      /* fused into the texture's sampler2D — skip */
    } else if (b.space === 'storage')
      throw new UnsupportedFeatureError(
        'glsl-es300: storage buffer (SSBO) — GLSL ES 3.00 has no SSBO; fail-closed',
      )
    else if (b.type.kind === 'struct')
      bindingLines.push(emitGlslUbo(b, structByName(structs, b.type.name), structs))
    // A LOOSE default-block uniform (set via glUniform*), rather than a std140 block.
    // Two ways in, and they are the same lowering reached for different reasons:
    //
    //   • `owner: 'host'` (#1710) — a HOST-OWNED uniform, which is what a GLSL host
    //     prelude actually provides. Declared per-value by `hostUniform`, so the choice
    //     is a property of the DECLARATION rather than of the whole emit. Before this,
    //     the only way to reach this spelling was to emit the block and cut it back open
    //     with string surgery — bypassing reflect(), and breaking outright under
    //     `minify()`, which collapses the whitespace such a parse depends on.
    //   • `emulateCompute` — the compute-GPGPU path's bare `u_count: uvec4`, unchanged.
    //
    // `precision` is emitted only when the declaration asked for one: a fragment composed
    // into a host program does not get our precision preamble, so the qualifier has to be
    // able to ride on the declaration itself (#1711).
    else if (
      b.space === 'uniform' &&
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- see lowerForGlsl: the deprecated flag's own implementation.
      (b.owner === 'host' || opts?.emulateCompute) &&
      (b.type.kind === 'scalar' || b.type.kind === 'vec' || b.type.kind === 'mat')
    )
      bindingLines.push(
        `uniform ${b.precision ? b.precision + ' ' : ''}${glslType(b.type)} ${b.name};`,
      )
    else
      throw new UnsupportedFeatureError(
        `glsl-es300: uniform binding '${b.name}' must be a struct (a std140 UBO block)`,
      )
  }
  if (bindingLines.length) parts.push(bindingLines.join('\n\n'))

  // Forward declarations for every helper. GLSL ES 3.00 has no hoisting, so without
  // prototypes the DEFINITION order is load-bearing (define-before-use) — an ordering
  // class module()'s transitive collection (#740 R1) would otherwise re-expose:
  // collected callees are prepended and may legitimately precede the extern-bodied
  // projection fns they call. Prototypes make the fn section order-free for good.
  if (helpers.length) {
    parts.push(
      helpers
        .map(
          (f) =>
            `${glslType(f.ret)} ${f.name}(${f.params.map((p) => `${glslType(p.type)} ${p.name}`).join(', ')});`,
        )
        .join('\n'),
    )
  }
  if (helpers.length)
    parts.push(helpers.map((f) => glslEs300Backend.emitFunc(f, opts?.parens)).join('\n\n'))
  if (entries.length && omitEntries !== true)
    parts.push(entries.map((f) => emitGlslEntry(f, structs, opts?.parens)).join('\n\n'))

  return {
    preamble,
    sections: parts,
    declares: {
      functions: helpers.map((f) => f.name),
      structs: [...structs.keys()].filter((n) => !bindingStructNames.has(n)),
      bindings: lowered.bindings
        .filter((b) => scope === null || scope.bindings.has(b.name))
        .map((b) => b.name),
      consts: lowered.consts.map((c) => c.name),
      overrides: (lowered.overrides ?? []).map((o) => o.name),
      entryPoints: entries.map((f) => f.name),
    },
    requires: fragmentRequires(lowered, helpers.concat(entries), 'glsl'),
  }
}

/** The preamble / body split of one GLSL assembly (#1711). `emitGlslModule` joins them
 *  back into the byte-identical whole; `emitGlslFragment` hands the preamble to the host
 *  as structured data and emits the body alone.
 *
 *  `sections` stays an ARRAY rather than a pre-joined string precisely so the join below
 *  can reproduce the original `parts` shape exactly. Pre-joining introduces a trailing
 *  newline that the empty-body case (a module of nothing but entries, emitted with
 *  `omitEntries`) then double-counts. */
interface GlslAssembly {
  readonly preamble: readonly string[]
  readonly sections: readonly string[]
  readonly declares: FragmentDeclares
  readonly requires: readonly string[]
}

/** Join a split assembly into a whole stage source — byte-identical to the pre-#1711
 *  emitter, whose `parts` array was `[...preamble, '', ...sections]`. */
const joinGlsl = (a: GlslAssembly, opts?: GlslEmitOptions): string =>
  applyTextPlugins([...a.preamble, '', ...a.sections].join('\n') + '\n', opts)

/** Resolve the PORTABLE KERNEL declaration (#1812) into this emit's options, ONCE, at the
 *  entry points — a portable-declared compute entry asks for exactly what `emulateCompute`
 *  asks for, so the tier takes the SAME code path rather than a parallel one.
 *
 *  Done as an option normalization rather than as a second condition inside `lowerForGlsl`
 *  because the compute-GPGPU emit reads the flag in TWO places: the IR half (which lowering
 *  chain runs) and the SPELLING half (`assembleGlsl`'s bare default-block `u_count: uvec4`,
 *  which a std140 block would break for the WebGL2 dispatcher). Normalizing makes the auto
 *  path byte-identical to the flag path by construction, for every combination of the other
 *  options, instead of by two conditions that must be kept in step. */
function withPortableLowering<T extends GlslEmitOptions>(m: ModuleDecl, opts?: T): T | undefined {
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- normalizing INTO the deprecated flag is the point: one code path, not two.
  if (opts?.emulateCompute === true || !m.funcs.some(isPortableComputeEntry)) return opts
  // Principled cast: T's own members all ride along through the spread; only the
  // GlslEmitOptions half is being set, and `emulateCompute` is optional in every T.
  return { ...opts, emulateCompute: true } as T
}

/** Emit one stage (or, with `stage` omitted, the whole module) as GLSL ES 3.00. */
export function emitGlslModule(
  m: ModuleDecl,
  stage?: 'vertex' | 'fragment',
  opts?: GlslEmitOptions,
): string {
  // The portable declaration resolves into the options FIRST (see withPortableLowering).
  const o = withPortableLowering(m, opts)
  // The `#extension` header comes from the AUTHORED module (#1670) — see assembleGlsl's
  // `extHeader` param.
  return joinGlsl(
    assembleGlsl(glslEs300Backend.modulePreamble?.(m) ?? '', lowerForGlsl(m, o), stage, o),
    o,
  )
}

/** Emit a module as a header-less GLSL ES 3.00 FRAGMENT (#1711) — the declarations and
 *  helpers, without `#version`, without the precision preamble, and (by default) without
 *  the stage entry point — for a host that owns the program and composes this into it.
 *
 *  What the preamble would have carried comes back as {@link EmitFragment.preamble}: the
 *  `#version` line, any `#extension … : require` a declared capability directs, and the
 *  precision lines — including the integer-sampler ones the backend derives from the
 *  module's own texture types (#1703). A host merges and de-duplicates those across the
 *  fragments it assembles; nothing is dropped, so no consumer has to regex them back.
 *
 *  Entry points are excluded unless `entryPoints: true`. They are still listed in
 *  `declares.entryPoints` either way, and they still decide the stage scope, so which
 *  helpers, structs and bindings the fragment carries is exactly what that stage needs.
 *
 *  @param m - the module to emit.
 *  @param stage - which stage's scope to emit; omit for the whole module.
 *  @param opts - the usual GLSL emit options, plus `entryPoints` to keep the entries.
 */
export function emitGlslFragment(
  m: ModuleDecl,
  stage?: 'vertex' | 'fragment',
  opts?: GlslEmitOptions & { entryPoints?: boolean },
): EmitFragment {
  // The portable declaration resolves into the options FIRST (see withPortableLowering).
  const o = withPortableLowering(m, opts)
  const a = assembleGlsl(
    glslEs300Backend.modulePreamble?.(m) ?? '',
    lowerForGlsl(m, o),
    stage,
    o,
    undefined,
    o?.entryPoints !== true,
  )
  return {
    source: applyTextPlugins(a.sections.join('\n') + '\n', o),
    preamble: a.preamble,
    declares: a.declares,
    requires: a.requires,
  }
}

/** Both stages of one module, lowered + OPTIMIZED ONCE. Byte-identical to calling
 *  `emitGlslModule(m,'vertex')` and `emitGlslModule(m,'fragment')` — the lowering is
 *  deterministic and the spelling half does not mutate it, which
 *  `glsl-stages-parity.test.ts` pins — but it pays the optimizer fixpoint once instead
 *  of twice. Use this from any host that creates a pipeline (it always needs both).
 *
 *  `vertexEntry` / `fragmentEntry` name the single entry to spell per stage, for the
 *  common case of a module carrying several (fs_fill / fs_fill_pattern, fs_line /
 *  fs_line_max / fs_line_pattern). Consumers expressed that by pruning the module's
 *  funcs before each emit, which is precisely what made the two stages need two
 *  lowerings; naming them here keeps one. Byte-identical to the prune-first form
 *  because every optimizer pass is per-function, so a func's spelled body does not
 *  depend on which OTHER funcs were present — pinned per family by
 *  `map/src/render/material/glsl-stage-entry-parity.test.ts`. */
export function emitGlslStages(
  m: ModuleDecl,
  opts?: GlslEmitOptions & { vertexEntry?: string; fragmentEntry?: string },
): { vertex: string; fragment: string } {
  // The portable declaration resolves into the options FIRST (see withPortableLowering).
  const o = withPortableLowering(m, opts)
  const lowered = lowerForGlsl(m, o)
  // Computed ONCE from the AUTHORED module, then shared by both stages — the header is a
  // module-level fact, not a per-stage one (#1670).
  const extHeader = glslEs300Backend.modulePreamble?.(m) ?? ''
  return {
    vertex: joinGlsl(assembleGlsl(extHeader, lowered, 'vertex', o, o?.vertexEntry), o),
    fragment: joinGlsl(assembleGlsl(extHeader, lowered, 'fragment', o, o?.fragmentEntry), o),
  }
}
