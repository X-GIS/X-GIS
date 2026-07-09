// ═══ Shader DSL — neutral intrinsic registry (the spelling SoT) ═══
//
// #3a — invert ownership. The IR no longer bakes the WGSL spelling into a call:
// builtins carry a NEUTRAL id (e.g. `bitcastU32`, `atan2`, `select`) and EACH
// backend maps id -> its own spelling here. Previously the id WAS the WGSL string
// and the GLSL writer had to UN-rename it (a WGSL leak at the core). Now the
// registry is the single source of truth; the WGSL writer is just one consumer.
//
// Only the DIVERGENT intrinsics need an entry — anything absent is spelled
// identically by both targets (`name(args)`), which also covers user-defined
// function calls (they flow through the same `call` op and pass through).

export type IntrinsicTarget = 'wgsl' | 'glsl'

type Spelling = {
  readonly wgsl: (args: readonly string[]) => string
  readonly glsl: (args: readonly string[]) => string
}

const join = (args: readonly string[]): string => args.join(', ')

/** Neutral intrinsic id -> per-target spelling. Absent = identity passthrough. */
export const INTRINSICS: Readonly<Record<string, Spelling>> = {
  // Scalar conversions — toF32/toI32/toU32 (node.ts) emit calls named f32/i32/u32 (the WGSL
  // cast spelling). GLSL spells the same cast `float(x)`/`int(x)`/`uint(x)`; without these
  // entries the writer would leak `f32(...)` verbatim into GLSL (no such GLSL function — a
  // hard compile error). Vector conversions go through `construct` (typeName-spelled), not here.
  f32: { wgsl: (a) => `f32(${join(a)})`, glsl: (a) => `float(${join(a)})` },
  i32: { wgsl: (a) => `i32(${join(a)})`, glsl: (a) => `int(${join(a)})` },
  u32: { wgsl: (a) => `u32(${join(a)})`, glsl: (a) => `uint(${join(a)})` },
  // select(falseVal, trueVal, cond) — WGSL builtin vs GLSL ternary.
  select: { wgsl: (a) => `select(${join(a)})`, glsl: (a) => `(${a[2]} ? ${a[1]} : ${a[0]})` },
  // textureSample(tex, samp, uv) — GLSL fuses tex+samp, so drop the sampler arg.
  textureSample: {
    wgsl: (a) => `textureSample(${join(a)})`,
    glsl: (a) => `texture(${a[0]}, ${a[2]})`,
  },
  atan2: { wgsl: (a) => `atan2(${join(a)})`, glsl: (a) => `atan(${join(a)})` },
  // Screen-space partial derivatives (#846) — WGSL dpdx/dpdy, GLSL dFdx/dFdy.
  // (fwidth is spelled identically on both targets and stays portable.)
  dpdx: { wgsl: (a) => `dpdx(${join(a)})`, glsl: (a) => `dFdx(${join(a)})` },
  dpdy: { wgsl: (a) => `dpdy(${join(a)})`, glsl: (a) => `dFdy(${join(a)})` },
  // mod(x, y) — FLOOR-mod with identical semantics on both targets (#839).
  // Float `%` is TRUNC-mod on WGSL and integer-only (invalid on floats) in
  // GLSL ES 3.00; GLSL's mod() IS floor-mod. Spelling WGSL inline as
  // x − y·⌊x/y⌋ makes the targets agree on negative operands (domain
  // repetition, polar folds). Named after GLSL/TSL `mod` — deliberately NOT
  // `fmod`, which in C/HLSL is TRUNC-mod (the opposite semantics). The WGSL
  // spelling repeats each operand's text — operands are pure expressions
  // (CSE hoists shared work), so this costs characters, not semantics.
  mod: {
    wgsl: (a) => `(${a[0]} - ${a[1]} * floor(${a[0]} / ${a[1]}))`,
    glsl: (a) => `mod(${join(a)})`,
  },
  inverseSqrt: { wgsl: (a) => `inverseSqrt(${join(a)})`, glsl: (a) => `inversesqrt(${join(a)})` },
  // fma(a,b,c) = a·b+c. WGSL has a fused hardware fma — a SINGLE rounding, atomic:
  // a driver's fast-math cannot distribute or reassociate it (unlike a·b then +c).
  // GLSL ES 3.00 (WebGL2) has NO fma (it is ES 3.10 / GLSL 4.00), so emit the
  // NON-fused `(a*b+c)` fallback there. DIVERGENT (not portable): only the WGSL
  // target gets the unfoldable single-rounding, which is the entire point — it is
  // the one form Apple/Metal cannot fold back into a plain f32 product when
  // building df64 twoProd error terms (aHi·bLo etc.). Diagnostic use for now.
  fma: { wgsl: (a) => `fma(${join(a)})`, glsl: (a) => `((${a[0]}) * (${a[1]}) + (${a[2]}))` },
  // GLSL ES 3.00 (WebGL2) has NO packUnorm4x8/unpackUnorm4x8 — those are GLSL 4.00 /
  // ES 3.10 only. Inline the WGSL semantics by hand (round(clamp(v,0,1)*255), byte 0 in
  // the low bits). Verified against the CPU oracle on a real WebGL2 GPU.
  pack4x8unorm: {
    wgsl: (a) => `pack4x8unorm(${join(a)})`,
    glsl: (a) =>
      `(uint(round(clamp(${a[0]}.x, 0.0, 1.0) * 255.0)) | (uint(round(clamp(${a[0]}.y, 0.0, 1.0) * 255.0)) << 8) | (uint(round(clamp(${a[0]}.z, 0.0, 1.0) * 255.0)) << 16) | (uint(round(clamp(${a[0]}.w, 0.0, 1.0) * 255.0)) << 24))`,
  },
  unpack4x8unorm: {
    wgsl: (a) => `unpack4x8unorm(${join(a)})`,
    glsl: (a) =>
      `(vec4(uvec4(${a[0]}, ${a[0]} >> 8, ${a[0]} >> 16, ${a[0]} >> 24) & 0xFFu) / 255.0)`,
  },
  // bitcast<u32>(f) on WGSL; floatBitsToUint(f) on GLSL. The neutral id drops the
  // WGSL generic-call syntax that used to live in the IR.
  bitcastU32: {
    wgsl: (a) => `bitcast<u32>(${join(a)})`,
    glsl: (a) => `floatBitsToUint(${join(a)})`,
  },
  // bitcast<f32>(u) on WGSL; uintBitsToFloat(u) on GLSL. Inverse of bitcastU32 —
  // an f32↔u32 round-trip is a fast-math optimization barrier (the integer domain
  // is not subject to float reassociation/contraction).
  bitcastF32: {
    wgsl: (a) => `bitcast<f32>(${join(a)})`,
    glsl: (a) => `uintBitsToFloat(${join(a)})`,
  },
  // GLSL texelFetch's lod/sample arg is `int` (WGSL passes a u32 level) → wrap the
  // 3rd arg in int(); GLSL has no implicit u32→int here. (2-arg form passes through.)
  textureLoad: {
    wgsl: (a) => `textureLoad(${join(a)})`,
    glsl: (a) =>
      a.length >= 3 ? `texelFetch(${a[0]}, ${a[1]}, int(${a[2]}))` : `texelFetch(${join(a)})`,
  },
  // GLSL textureSize REQUIRES an int lod (WGSL textureDimensions(t) defaults to base
  // level 0); supply 0 when absent, else cast the given level to int. WGSL
  // textureDimensions returns vec2<u32> but GLSL textureSize returns a SIGNED ivec2 —
  // wrap in uvec2() so the GLSL type matches the IR's u32 type. Without this the
  // mismatch is masked while the call is inlined into an int context, but breaks the
  // moment the optimizer's CSE hoists it into a typed `uvec2 _cse = …` local.
  textureDimensions: {
    wgsl: (a) => `textureDimensions(${join(a)})`,
    glsl: (a) =>
      a.length >= 2
        ? `uvec2(textureSize(${a[0]}, int(${a[1]})))`
        : `uvec2(textureSize(${a[0]}, 0))`,
  },
  // The fp64 anti-fast-math guard VALUE (runtime 1.0), spelled as a texel
  // fetch from the injected `_fp64` 1×1 texture (passes/fp64-lower.ts owns
  // the binding; the name is reserved). A UBO-sourced guard is defeated by
  // drivers that SPECIALIZE pipelines on observed uniform values and hot-swap
  // re-optimized variants (seen in the field: Windows/NVIDIA folding the df64
  // error-free-transformation terms mid-session) — no driver constant-folds
  // texel values. Zero-arg; the CPU oracle evaluates it as exactly 1.
  f64Guard: {
    wgsl: () => 'textureLoad(_fp64, vec2<i32>(0, 0), 0).x',
    glsl: () => 'texelFetch(_fp64, ivec2(0, 0), 0).x',
  },
  // Storage-buffer emulation (WebGL2 has no SSBO): GLSL-only synthetic. A storage read
  // data[i] lowers to a fetch from a DATA TEXTURE — a[0]=the sampler, a[1]=the element index.
  // 2D-TILED: the linear index maps to (i % W, i / W) where W = the texture's own width
  // (textureSize(t,0).x), so an array wider than one texture row (>maxTextureSize) wraps
  // across rows AND the 1-row case is unchanged (W=N → i%N=i, i/N=0). The shader reads the
  // device-chosen width, so no compile-time width constant needs syncing. Only the GLSL
  // backend sees this call (the pre-pass creates it); the wgsl spelling is unused.
  storageFetchF32: {
    wgsl: (a) => `storageFetchF32(${join(a)})`,
    glsl: (a) =>
      `texelFetch(${a[0]}, ivec2(int(${a[1]}) % textureSize(${a[0]}, 0).x, int(${a[1]}) / textureSize(${a[0]}, 0).x), 0).r`,
  },
}

// ── Spelling-embedded binding references ──
//
// Bindings an intrinsic's SPELLING references TEXTUALLY, with no Expr arg
// carrying them (f64Guard is zero-arg; its fetch names `_fp64` directly).
// Reference collection over the IR (ir/collect-refs) cannot see these — any
// consumer that decides "is this binding used?" (the GLSL per-stage emit
// scope) must also keep every binding listed here for each intrinsic it
// calls. An intrinsic that gains a hardcoded binding name MUST register it
// here, or per-stage emit drops the binding while the spelling still names it
// (a GPU compile error, caught by the compile gates).
export const INTRINSIC_BINDING_REFS: Readonly<Record<string, readonly string[]>> = {
  f64Guard: ['_fp64'],
}

/** Spell an intrinsic / call for a target. Registry id -> mapped spelling;
 *  otherwise identity `name(args)` (portable builtins + user-defined fn calls). */
export function spellIntrinsic(
  target: IntrinsicTarget,
  name: string,
  args: readonly string[],
): string {
  const entry = INTRINSICS[name]
  if (entry) return entry[target](args)
  return `${name}(${join(args)})`
}

// ── Portable builtins (the EXPLICIT identity-spelled set) ──
//
// The DSL's free-function builtins (core/ir/node.ts) emit a `call` whose `fn` id is spelled
// IDENTICALLY in WGSL and GLSL ES 3.00 — so they need no INTRINSICS entry and fall through
// `spellIntrinsic` as `name(args)`. The risk that makes the registry a silent agreement
// surface: a NEW builtin whose spelling actually DIVERGES, added without an INTRINSICS entry,
// also falls through — emitting the same (wrong-on-one-target) string, caught only at GPU
// compile time. Listing the portable ids EXPLICITLY here turns "absent = assume identity" into
// "absent = unclassified", which the catalogue test (intrinsic-coverage.test.ts) flags: every
// builtin id the surface emits must be in INTRINSICS (divergent) OR here (asserted identical).
export const PORTABLE_INTRINSICS: ReadonlySet<string> = new Set([
  // genType1 (component-wise unary) — same name in WGSL + GLSL ES 3.00.
  'sin',
  'cos',
  'tan',
  'asin',
  'acos',
  'atan',
  'exp',
  'log',
  'log2',
  'exp2',
  'floor',
  'ceil',
  'abs',
  'sqrt',
  'fract',
  'trunc',
  'round',
  'sign',
  'radians',
  'degrees',
  'normalize',
  'fwidth',
  // multi-arg math — identical spelling on both targets.
  'min',
  'max',
  'pow',
  'clamp',
  'mix',
  'smoothstep',
  'step',
  'length',
  'dot',
  'distance',
  'cross',
])

// ── Pre-emit-consumed builtins (the THIRD classification) ──
//
// Ids the authoring surface emits that are consumed ENTIRELY by a pre-emit
// pass and must NEVER reach spellIntrinsic on any target: the fp64 widen
// `'f64'` (toF64 / the implicit f32→f64 widen), `'f64FromParts'` (hi/lo lane
// pair → f64), and `'f64Parts'` (f64 → its vec2 pair) are rewritten by
// fp64Lower into constructs / the identity. The CPU oracle evaluates them
// natively (BUILTINS); if one leaked to a backend the emitted call is invalid
// GLSL — the wgslType/glslType SD0040 backstops make the leak loud.
export const PRE_EMIT_INTRINSICS: ReadonlySet<string> = new Set(['f64', 'f64FromParts', 'f64Parts'])

/** True if `name` is a builtin the registry knows how to spell on every target — either a
 *  DIVERGENT id (INTRINSICS) or an asserted-portable identity id (PORTABLE_INTRINSICS). A `call`
 *  id that is neither is EITHER a user/extern fn (fine — same spelling everywhere) OR an
 *  unclassified builtin (a latent silent-wrong-emit). The catalogue test uses this to assert the
 *  DSL's own builtin surface is fully classified. (PRE_EMIT_INTRINSICS ids are deliberately NOT
 *  "known" here — they are unspellable by construction.) */
export const isKnownIntrinsic = (name: string): boolean =>
  Object.prototype.hasOwnProperty.call(INTRINSICS, name) || PORTABLE_INTRINSICS.has(name)
