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
// FAIL-CLOSED (GLSL ES 3.00 has no SSBO / compute / MSAA-load): a `storage`
// binding, a `@compute` entry, and a multisampled-texture load all raise
// UnsupportedFeatureError — enforced UP FRONT by the shared capability gate
// (assertCaps, run inside lowerForBackend) because glslEs300Backend.caps is the
// empty set, so this writer never sees such a module. Storage-buffer emulation
// (data textures) is explicitly out of scope for ES 3.00.
//
// ─── COMPILE GATE ───
// glsl.test.ts (string-shape: version pragma, std140 block + engine-matched
// offsets, in/out varyings, main()) + the headless-WebGL2 gate cover the emit.

import type { ShaderType, ModuleDecl, StructDecl, BindingDecl, FuncDecl, Expr, Stmt } from '../ir'
import { texture2dfT, u32T, f32T, vec4fT, stageOf } from '../ir'
import { collectFnRefs, emptyRefSet, typeStructNames } from '../ir/collect-refs'
import { Capabilities, UnsupportedFeatureError, type Backend } from '../backend'
import { spellIntrinsic, INTRINSIC_BINDING_REFS } from '../intrinsics'
import { bodyHasRaw } from '../passes/opt/dce'
import { dslError } from '../diagnostics/error'
import { f32Lit } from './wgsl'
import {
  emitBody,
  emitExpr as emitExprNeutral,
  lowerForBackend,
  applyIRPlugins,
  applyTextPlugins,
  type EmitOptions,
} from '../emit'
import { autoVars } from '../passes/opt'
import { wgslLayout } from '../reflect'
import { sanitizeReservedIdents } from './glsl-sanitize'
import { fixpoint } from '../passes/opt'

// UnsupportedFeatureError now lives in the backend contract; re-exported here so
// existing importers (`from './glsl'`) keep working.
export { UnsupportedFeatureError } from '../backend'

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
    case 'texture':
      if (t.dim === '2d-ms')
        throw new UnsupportedFeatureError(
          'glsl-es300: multisampled texture sampling — resolve first (later step)',
        )
      return 'sampler2D' // GLSL fuses texture+sampler into one combined sampler
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
const BUILTIN_IN: Readonly<Record<string, string>> = {
  position: 'gl_FragCoord', // a readable @builtin(position) is a fragment input → gl_FragCoord
  vertex_index: 'gl_VertexID',
  instance_index: 'gl_InstanceID',
  frag_coord: 'gl_FragCoord',
  front_facing: 'gl_FrontFacing',
}
const BUILTIN_OUT: Readonly<Record<string, string>> = {
  position: 'gl_Position',
  frag_depth: 'gl_FragDepth',
}

function builtinIn(b: string): string {
  const g = BUILTIN_IN[b]
  if (!g)
    throw new UnsupportedFeatureError(
      `glsl-es300: unsupported input @builtin(${b}) — no readable gl_* mapping`,
    )
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
export const glslEs300Backend: Backend = {
  id: 'glsl-es300',
  caps: new Capabilities(new Set()), // no storage buffers, no compute, no MSAA-load on WebGL2
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
  // C-style GLSL switch falls through — each case must `break` or it leaks into the next.
  caseBreak: 'break;',
  rawStmt: () => {
    throw new UnsupportedFeatureError(
      'glsl-es300: raw WGSL Stmt cannot lower to GLSL (backendOnly:wgsl)',
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
  // map), so the bare method fails closed to keep the offset SoT in one place. Storage is
  // gated out by assertCaps before emit; the throw here is belt-and-braces.
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
  emitFunc: (f) => {
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
    return `${glslType(f.ret)} ${f.name}(${params}) {\n${emitBody(f.body, 1, glslEs300Backend)}\n}`
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
function emitGlslEntry(f: FuncDecl, structs: ReadonlyMap<string, StructDecl>): string {
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
  lines.push(`${retTy} ${impl}(${params}) {\n${emitBody(f.body, 1, glslEs300Backend)}\n}`)

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
 *  assertCaps step fails closed (UnsupportedFeatureError) on storage/compute/MSAA BEFORE
 *  any GLSL is produced, since glslEs300Backend.caps is the empty set.
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
// run BEFORE the standard pipeline, ONLY when emitGlslModule({emulateStorage}) opts in —
// rewrites the IR so the standard pipeline never sees a storage binding:
//   • the storage `array<f32>` binding becomes a `sampler2D` (a 2D-TILED R32F DATA TEXTURE)
//   • a read `data[i]` becomes `storageFetchF32(data, i)` → texelFetch at (i % W, i / W) where
//     W = textureSize(data,0).x (the device-chosen width), so an array wider than one texture
//     row (>maxTextureSize) wraps across rows; the 1-row case is W=N → (i, 0).
// Because the rewritten module has NO storage binding, assertCaps (which keys on
// space==='storage') passes with the normal empty-caps backend — no caps loosening, so
// compute/MSAA stay fail-closed, and the DEFAULT emitGlslModule (no opt-in) still
// fail-closes storage. WGSL is untouched (only emitGlslModule calls this).
//
// SCOPE: array<f32> (any size, 2D-tiled) — covers the real feat_data path (indexed / strided
// feat_data[base*STRIDE+lane] / bitcast<u32> lanes) — plus array<vecN<f32>> (the retained-icon
// tint_data path, #823): element i reads its std430 stride worth of consecutive lanes
// (vec2 = 2, vec3/vec4 = 4 — vec3 arrays pad to 16 B per std430) recombined with a vec ctor.
// The RESIDUAL (fail-closed below): array<u32/i32> — needs a typed-texture / bitcast-lane
// scheme (a documented follow-on, NOT yet implemented).
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

function lowerStorageToDataTexture(m: ModuleDecl): ModuleDecl {
  const structsMap = new Map(m.structs.map((s) => [s.name, s]))
  const f32Names = new Set<string>() // array<f32> storage
  // array<vecN<f32>> storage — element i = `stride` consecutive f32 lanes (std430:
  // vec2 stride 2, vec3/vec4 stride 4), the first `n` recombined with a vec ctor.
  const vecStorage = new Map<string, { n: number; stride: number }>()
  const structStorage = new Map<string, StructStorage>() // array<Struct> storage
  for (const b of m.bindings) {
    if (b.space !== 'storage') continue
    if (b.type.kind !== 'array')
      throw new UnsupportedFeatureError(
        `glsl-es300 storage-emul: binding '${b.name}' is not an array`,
      )
    const elem = b.type.elem
    if (elem.kind === 'scalar' && elem.scalar === 'f32') {
      f32Names.add(b.name)
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
              `glsl-es300 storage-emul: i32 struct field '${f.name}' — only f32/u32 lanes supported`,
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
      `glsl-es300 storage-emul: binding '${b.name}' — array<f32>, array<vecN<f32>> and array<Struct(scalar fields)> supported; a top-level array<u32/i32> needs typed packing`,
    )
  }
  if (f32Names.size === 0 && vecStorage.size === 0 && structStorage.size === 0) return m
  const allNames = new Set<string>([...f32Names, ...vecStorage.keys(), ...structStorage.keys()])
  // every storage binding → a sampler2D (R32F data texture) uniform; same name/group/binding.
  const bindings = m.bindings.map((b): BindingDecl =>
    allNames.has(b.name) ? { ...b, space: 'uniform', type: texture2dfT } : b,
  )
  const u32lit = (value: number): Expr => ({ op: 'lit', type: u32T, value })
  const fetch = (name: string, lane: Expr): Expr => ({
    op: 'call',
    type: f32T,
    fn: 'storageFetchF32',
    args: [{ op: 'varref', type: texture2dfT, name }, lane],
  })
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
              `glsl-es300 storage-emul: '${b.base.name}[i].${e.field}' — mat / vec<u32> / nested-struct fields not supported (only scalar + vecN<f32> lanes)`,
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
            `glsl-es300 storage-emul: storage struct element '${e.base.name}[i]' used without a .field access`,
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
export function lowerComputeToFragment(m: ModuleDecl): ModuleDecl {
  const entry = m.funcs.find(
    (f) => f.stage === 'compute' || f.attrs?.some((a) => a.startsWith('@compute')),
  )
  if (!entry)
    throw new UnsupportedFeatureError('glsl-es300 compute-emul: no @compute entry in module')
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

export function emitGlslModule(
  m: ModuleDecl,
  stage?: 'vertex' | 'fragment',
  opts?: {
    emulateStorage?: boolean
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
  } & EmitOptions,
): string {
  // autoVars BEFORE lowerModule (inside lowerForBackend), same order as the WGSL backend /
  // CPU oracle — materialising assigned plain-value bindings into real vars is BACKEND-NEUTRAL.
  // Opt-in storage→data-texture emulation runs FIRST so the rewritten module carries no
  // storage binding (assertCaps then passes with the normal empty-caps backend).
  // Opt-in compute→fragment lowering runs FIRST (strips the @compute attr + the
  // read_write `out_color` binding, which lowerStorageToDataTexture would throw on),
  // then storage→data-texture converts the remaining `feat_data` read. emulateCompute
  // IMPLIES emulateStorage.
  // autoVars must run BEFORE any cloning IR→IR pre-pass: it materialises
  // assigned plain-value bindings by Expr OBJECT IDENTITY (see auto-vars.ts),
  // and the storage/compute lowerings clone expression trees — running them
  // first orphans every read of an assigned temp from its assignments (the
  // emitted GLSL then reads the CSE'd INITIALIZER forever; the #834 M5 line
  // twin returned position = vec4(0) this way). autoVars is a no-op on an
  // already-materialised module, so lowerForBackend's own autoVars stays.
  const src = opts?.emulateCompute
    ? lowerStorageToDataTexture(lowerComputeToFragment(autoVars(m)))
    : opts?.emulateStorage
      ? lowerStorageToDataTexture(autoVars(m))
      : m
  // GLSL-local: rename any param/var identifier colliding with a GLSL reserved word
  // (e.g. an entry param `input` / `in`) — does NOT affect the WGSL backend.
  // The transformIR plugins (production tooling — emit-prod's mangle) run LAST in
  // the IR chain; their contract requires determinism on the lowered module, so
  // the vertex and fragment emits (separate calls over the same module) agree on
  // every shared transformed name.
  const lowered = applyIRPlugins(
    sanitizeReservedIdents(lowerForBackend(src, glslEs300Backend, undefined, opts?.fp64Flavor)),
    opts,
  )
  const structs = new Map(lowered.structs.map((s) => [s.name, s]))

  // Stage filter through the shared predicate (#763 S3) — the old attr-string
  // match silently DROPPED a structured-only entry from its own stage's emit.
  const entries = lowered.funcs.filter(
    (f) => isEntry(f) && (stage === undefined || stageOf(f) === stage),
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

  // `precision highp int;` too: a GLSL ES 3.00 FRAGMENT shader has NO default int
  // precision, so a uint/int varying or expression there is a compile error without it.
  const parts: string[] = ['#version 300 es', 'precision highp float;', 'precision highp int;', '']

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
    // compute-GPGPU only: a bare scalar/vec uniform (u_count: uvec4) emits as a
    // default-block uniform (set via glUniform*). Gated behind emulateCompute so the
    // existing "uniform binding must be a struct" invariant is unchanged for every
    // vertex/fragment caller (critique #3).
    else if (
      opts?.emulateCompute &&
      b.space === 'uniform' &&
      (b.type.kind === 'scalar' || b.type.kind === 'vec')
    )
      bindingLines.push(`uniform ${glslType(b.type)} ${b.name};`)
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
  if (helpers.length) parts.push(helpers.map((f) => glslEs300Backend.emitFunc(f)).join('\n\n'))
  if (entries.length) parts.push(entries.map((f) => emitGlslEntry(f, structs)).join('\n\n'))

  return applyTextPlugins(parts.join('\n') + '\n', opts)
}
