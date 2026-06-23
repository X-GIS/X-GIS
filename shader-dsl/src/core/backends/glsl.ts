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

import type { ShaderType, ModuleDecl, StructDecl, BindingDecl, FuncDecl } from '../ir'
import { Capabilities, UnsupportedFeatureError, type Backend } from '../backend'
import { spellIntrinsic } from '../intrinsics'
import { f32Lit } from './wgsl'
import { emitBody, lowerForBackend } from '../emit'
import { wgslLayout } from '../reflect'

// UnsupportedFeatureError now lives in the backend contract; re-exported here so
// existing importers (`from './glsl'`) keep working.
export { UnsupportedFeatureError } from '../backend'

function glslType(t: ShaderType): string {
  switch (t.kind) {
    case 'scalar': return ({ f32: 'float', i32: 'int', u32: 'uint', bool: 'bool' } as const)[t.scalar]
    case 'vec': return `${({ f32: 'vec', i32: 'ivec', u32: 'uvec' } as const)[t.elem]}${t.n}`
    case 'mat': return `mat${t.n}`
    case 'struct': return t.name
    case 'array': {
      if (t.size === undefined) throw new UnsupportedFeatureError('glsl-es300: runtime-sized array (storage buffer) — needs a data-texture (later step)')
      return `${glslType(t.elem)}[${t.size}]`
    }
    case 'texture':
      if (t.dim === '2d-ms') throw new UnsupportedFeatureError('glsl-es300: multisampled texture sampling — resolve first (later step)')
      return 'sampler2D' // GLSL fuses texture+sampler into one combined sampler
    case 'sampler': throw new UnsupportedFeatureError('glsl-es300: standalone sampler — fused into the combined sampler2D')
    case 'void': return 'void'
  }
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

const isEntry = (f: FuncDecl): boolean => !!f.attrs?.some((a) => a.startsWith('@vertex') || a.startsWith('@fragment'))

/** Parse a StructField.attr / a bare param attr into {location|builtin}. */
function parseAttr(attr: string | undefined): { location?: number; builtin?: string } {
  if (!attr) return {}
  const loc = attr.match(LOCATION_RE)
  if (loc) return { location: Number(loc[1]) }
  const b = attr.match(BUILTIN_RE)
  if (b) return { builtin: b[1] }
  return {}
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
  if (!g) throw new UnsupportedFeatureError(`glsl-es300: unsupported input @builtin(${b}) — no readable gl_* mapping`)
  return g
}
function builtinOut(b: string): string {
  const g = BUILTIN_OUT[b]
  if (!g) throw new UnsupportedFeatureError(`glsl-es300: unsupported output @builtin(${b}) — no writable gl_* mapping`)
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
  localVar: (name, type, init) => init !== undefined ? `${glslType(type)} ${name} = ${init}` : `${glslType(type)} ${name}`,
  constDecl: (name, type, value) => `const ${glslType(type)} ${name} = ${value};`,
  caseLabel: (value) => `${value}`, // GLSL ES switch requires int labels (no `u` suffix)
  switchHead: (scrut) => `switch (${scrut}) {`,
  rawStmt: () => { throw new UnsupportedFeatureError('glsl-es300: raw WGSL Stmt cannot lower to GLSL (backendOnly:wgsl)') },
  placeholderStmt: () => { throw new UnsupportedFeatureError('glsl-es300: un-swapped placeholder Stmt — composer must run first') },
  // ── Module-decl surface ──
  emitConst: (c) => glslEs300Backend.constDecl(c.name, c.type, f32Lit(c.wgslValue)),
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
    if (b.type.kind === 'texture' || b.type.kind === 'sampler') return `uniform ${glslType(b.type)} ${b.name};`
    if (b.space === 'storage') throw new UnsupportedFeatureError('glsl-es300: storage buffer (SSBO) — GLSL ES 3.00 has no SSBO; fail-closed')
    throw new UnsupportedFeatureError(`glsl-es300: uniform struct binding '${b.name}' — std140 UBO is assembled by emitGlslModule (needs the struct map)`)
  },
  emitFunc: (f) => {
    // Entry funcs are lowered to varyings + main() by emitGlslModule; a stray entry
    // reaching emitFunc means the assembly bypassed that path — fail loudly.
    if (isEntry(f)) throw new UnsupportedFeatureError(`glsl-es300: entry func '${f.name}' must lower via emitGlslModule's entry path`)
    if (f.attrs?.length) throw new UnsupportedFeatureError(`glsl-es300: non-entry func '${f.name}' carries stage attrs (${f.attrs.join(' ')})`)
    const params = f.params.map((p) => `${glslType(p.type)} ${p.name}`).join(', ')
    return `${glslType(f.ret)} ${f.name}(${params}) {\n${emitBody(f.body, 1, glslEs300Backend)}\n}`
  },
  // GLSL has no emit-time auto-cache (cse stays WGSL-only so byte-identity holds); identity.
  optimize: (lowered) => lowered,
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
function emitGlslUbo(b: BindingDecl, struct: StructDecl): string {
  wgslLayout(struct, 'std140') // offset oracle + host-shareable-field guard; offsets are the contract
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
  const stage: 'vertex' | 'fragment' = f.attrs?.some((a) => a.startsWith('@fragment')) ? 'fragment' : 'vertex'
  const lines: string[] = []

  // input-varying GLSL name: a vertex attribute is `a_`-prefixed (so it can't collide with
  // a same-named vertex OUT varying); a fragment input keeps the field name (it links by
  // name to the vertex OUT of the same name).
  const inName = (n: string) => (stage === 'vertex' ? `a_${n}` : n)

  // `in` varyings: each entry param that is a struct contributes its @location fields;
  // a bare @location param contributes itself. @builtin fields read from gl_* globals.
  for (const p of f.params) {
    const fields = p.type.kind === 'struct'
      ? structByName(structs, p.type.name).fields.map((sf) => ({ name: sf.name, type: sf.type, ...parseAttr(sf.attr) }))
      // A bare entry param carries its stage attr as `attr` (the `@location(n)`/`@builtin(...)`
      // string the location()/builtin() helpers emit) OR as direct location/builtin fields (raw IR).
      : [{ name: p.name, type: p.type, location: p.location ?? parseAttr(p.attr).location, builtin: p.builtin ?? parseAttr(p.attr).builtin }]
    for (const s of fields) {
      if (s.builtin) continue
      if (s.location === undefined) throw new UnsupportedFeatureError(`glsl-es300: entry '${f.name}' input '${s.name}' has neither @location nor @builtin`)
      // location qualifier ONLY on a vertex attribute; a fragment input varying drops it.
      const qual = stage === 'vertex' ? `layout(location = ${s.location}) ` : ''
      lines.push(`${qual}in ${glslType(s.type)} ${inName(s.name)};`)
    }
  }
  // `out` varyings: the return struct's @location fields (or a bare @location return).
  const retFields = f.ret.kind === 'struct'
    ? structByName(structs, f.ret.name).fields.map((sf) => ({ name: sf.name, type: sf.type, ...parseAttr(sf.attr) }))
    : f.ret.kind === 'void' ? []
      : [{ name: '_ret', type: f.ret, ...parseAttr(f.retAttr) }]
  for (const s of retFields) {
    if (s.builtin) continue
    if (s.location === undefined) throw new UnsupportedFeatureError(`glsl-es300: entry '${f.name}' output '${s.name}' has neither @location nor @builtin`)
    // location qualifier ONLY on a fragment draw buffer; a vertex output varying drops it.
    const qual = stage === 'fragment' ? `layout(location = ${s.location}) ` : ''
    lines.push(`${qual}out ${glslType(s.type)} ${s.name};`)
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
        const { builtin } = parseAttr(sf.attr)
        body.push(`  ${p.name}.${sf.name} = ${builtin ? builtinIn(builtin) : inName(sf.name)};`)
      }
      args.push(p.name)
    } else {
      const bi = p.builtin ?? parseAttr(p.attr).builtin
      args.push(bi ? builtinIn(bi) : inName(p.name))
    }
  }
  const call = `${impl}(${args.join(', ')})`
  if (f.ret.kind === 'struct') {
    const s = structByName(structs, f.ret.name)
    body.push(`  ${glslType(f.ret)} _out = ${call};`)
    for (const sf of s.fields) {
      const { builtin, location } = parseAttr(sf.attr)
      if (builtin) body.push(`  ${builtinOut(builtin)} = _out.${sf.name};`)
      else if (location !== undefined) body.push(`  ${sf.name} = _out.${sf.name};`)
    }
  } else if (f.ret.kind === 'void') {
    body.push(`  ${call};`)
  } else {
    const { builtin } = parseAttr(f.retAttr)
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
export function emitGlslModule(m: ModuleDecl, stage?: 'vertex' | 'fragment'): string {
  // autoVars BEFORE lowerModule (inside lowerForBackend), same order as the WGSL backend /
  // CPU oracle — materialising assigned plain-value bindings into real vars is BACKEND-NEUTRAL.
  const lowered = lowerForBackend(m, glslEs300Backend)
  const structs = new Map(lowered.structs.map((s) => [s.name, s]))

  const stageAttr = stage === 'vertex' ? '@vertex' : stage === 'fragment' ? '@fragment' : undefined
  const entries = lowered.funcs.filter((f) => isEntry(f) && (stageAttr === undefined || f.attrs?.some((a) => a.startsWith(stageAttr))))
  const helpers = lowered.funcs.filter((f) => !isEntry(f))

  // A struct consumed as a uniform/storage BINDING type becomes a UBO/SSBO block, NOT a
  // GLSL `struct` decl — reusing its name for both a `struct` and a `uniform <Name> {…}`
  // block is a redeclaration error. EVERY OTHER struct (IO in/out + storage-element +
  // nested + helper-fn arg) IS emitted as a plain GLSL struct: the entry's `_impl` fn
  // signature references the IO struct types, and storage-element structs are read field-
  // wise — both need a real `struct` decl.
  const bindingStructNames = new Set<string>()
  for (const b of lowered.bindings) if (b.type.kind === 'struct') bindingStructNames.add(b.type.name)

  // `precision highp int;` too: a GLSL ES 3.00 FRAGMENT shader has NO default int
  // precision, so a uint/int varying or expression there is a compile error without it.
  const parts: string[] = ['#version 300 es', 'precision highp float;', 'precision highp int;', '']

  if (lowered.consts.length) parts.push(lowered.consts.map((c) => glslEs300Backend.emitConst(c)).join('\n'))

  const plainStructs = lowered.structs.filter((s) => !bindingStructNames.has(s.name))
  if (plainStructs.length) parts.push(plainStructs.map((s) => glslEs300Backend.emitStruct(s)).join('\n\n'))

  // Uniform UBO blocks (std140, reflection-fed) + texture/sampler uniforms.
  const bindingLines: string[] = []
  for (const b of lowered.bindings) {
    if (b.type.kind === 'texture' || b.type.kind === 'sampler') bindingLines.push(`uniform ${glslType(b.type)} ${b.name};`)
    else if (b.space === 'storage') throw new UnsupportedFeatureError('glsl-es300: storage buffer (SSBO) — GLSL ES 3.00 has no SSBO; fail-closed')
    else if (b.type.kind === 'struct') bindingLines.push(emitGlslUbo(b, structByName(structs, b.type.name)))
    else throw new UnsupportedFeatureError(`glsl-es300: uniform binding '${b.name}' must be a struct (a std140 UBO block)`)
  }
  if (bindingLines.length) parts.push(bindingLines.join('\n\n'))

  if (helpers.length) parts.push(helpers.map((f) => glslEs300Backend.emitFunc(f)).join('\n\n'))
  if (entries.length) parts.push(entries.map((f) => emitGlslEntry(f, structs)).join('\n\n'))

  return parts.join('\n') + '\n'
}
