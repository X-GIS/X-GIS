// ═══ Shader DSL — reserved-word vocabulary for GENERATED identifiers ═══
//
// Every emit-prod pass that INVENTS a short identifier — `mangle`'s local/helper
// pool and `emit-alias`'s type aliases — walks the same bijective base-52
// sequence (`a, b, … Z, aa, ab, …`) and so can land on a spelling the target
// language owns. One shared blocklist, because two lists drift: `mangle` had the
// keywords but not WGSL's separate FUTURE-keyword list, and `emit-alias` derived
// its blocklist from the words the emitted TEXT happens to contain — so both
// independently handed out `as`, which Tint rejects (#1861).
//
// Contents: both languages' keywords, the type/qualifier vocabulary the BACKENDS
// write textually (`vec2`, `float`, `layout`, `precision` — none of it appears in
// the IR, so an identifier sweep cannot see it), and both reserved-word lists.
// Only letters-only spellings can ever be generated, so `_`- and digit-bearing
// entries are deliberately absent. Everything that DOES appear in the IR
// (intrinsic call targets, binding names, struct fields, overrides) is collected
// from the module by each caller instead — this list only has to cover the
// textual half.

/** Spellings a GENERATED identifier must never take. See the module header. */
export const RESERVED_WORDS: ReadonlySet<string> = new Set([
  // WGSL
  'alias',
  'break',
  'case',
  'const',
  'const_assert',
  'continue',
  'continuing',
  'default',
  'diagnostic',
  'discard',
  'else',
  'enable',
  'false',
  'fn',
  'for',
  'if',
  'let',
  'loop',
  'override',
  'requires',
  'return',
  'struct',
  'switch',
  'true',
  'var',
  'while',
  // GLSL ES 3.00
  'attribute',
  'centroid',
  'coherent',
  'do',
  'flat',
  'highp',
  'in',
  'inout',
  'invariant',
  'layout',
  'lowp',
  'main',
  'mediump',
  'noperspective',
  'out',
  'precision',
  'readonly',
  'restrict',
  'smooth',
  'uniform',
  'varying',
  'void',
  'volatile',
  'writeonly',
  // scalar / vector / matrix / opaque types, both languages
  'bool',
  'f16',
  'f32',
  'float',
  'i32',
  'int',
  'u32',
  'uint',
  'half',
  'double',
  'atomic',
  'array',
  'ptr',
  'ref',
  'texture',
  // sampler types, GLSL ES 3.00 §3.7 — the same completion as glsl-sanitize's set
  // (#1703): the float 2D/3D/Cube trio was ES-1.00-era and left every array/integer
  // sampler spelling absent.
  'sampler',
  'sampler2D',
  'sampler3D',
  'samplerCube',
  'sampler2DShadow',
  'samplerCubeShadow',
  'sampler2DArray',
  'sampler2DArrayShadow',
  'isampler2D',
  'isampler3D',
  'isamplerCube',
  'isampler2DArray',
  'usampler2D',
  'usampler3D',
  'usamplerCube',
  'usampler2DArray',
  'vec2',
  'vec3',
  'vec4',
  'bvec2',
  'bvec3',
  'bvec4',
  'ivec2',
  'ivec3',
  'ivec4',
  'uvec2',
  'uvec3',
  'uvec4',
  'mat2',
  'mat3',
  'mat4',
  'mat2x2',
  'mat2x3',
  'mat2x4',
  'mat3x2',
  'mat3x3',
  'mat3x4',
  'mat4x2',
  'mat4x3',
  'mat4x4',
  // ── the FUTURE-keyword lists (#1861) ──
  // Both languages reserve a second, much longer vocabulary ALONGSIDE their
  // keywords — WGSL's "Reserved Words" section, GLSL ES 3.00's §3.6 list. `as`
  // is on WGSL's; `nthName` reaches it at the ~70th name in a scope, and Tint
  // rejects `let as = …`. Since the generator emits `[a-zA-Z]+`, EVERY
  // letters-only spelling on those lists is reachable and all of them belong
  // here — a partial list is exactly what failed. Kept as split text rather
  // than one entry per line: this is spec data, and it would otherwise triple
  // the file. Duplicates of the keywords above are harmless (this is a Set).
  ...`NULL Self abstract active alignas alignof as asm async auto await become buffer
      cast catch class common compile concept consteval constexpr constinit crate debugger
      decltype delete demote dvec2 dvec3 dvec4 enum explicit export extends extern external
      fallthrough filter final finally fixed friend from fvec2 fvec3 fvec4 fxgroup get goto
      groupshared hvec2 hvec3 hvec4 impl implements import inline input instanceof interface
      long macro match meta mod module move mut mutable namespace new nil noexcept noinline
      nointerpolation noncoherent null nullptr of operator output package packed packoffset
      partition pass patch pixelfragment precise premerge priv protected pub public
      regardless register require resource sample self set shared short sizeof snorm static
      std subroutine super superp target tempate template this throw trait try type typedef
      typeid typename typeof union unless unorm unsafe unsigned unsized use using virtual
      wgsl where yield`.split(/\s+/),
])
