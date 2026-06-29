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

type Spelling = { readonly wgsl: (args: readonly string[]) => string; readonly glsl: (args: readonly string[]) => string }

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
  textureSample: { wgsl: (a) => `textureSample(${join(a)})`, glsl: (a) => `texture(${a[0]}, ${a[2]})` },
  atan2: { wgsl: (a) => `atan2(${join(a)})`, glsl: (a) => `atan(${join(a)})` },
  inverseSqrt: { wgsl: (a) => `inverseSqrt(${join(a)})`, glsl: (a) => `inversesqrt(${join(a)})` },
  pack4x8unorm: { wgsl: (a) => `pack4x8unorm(${join(a)})`, glsl: (a) => `packUnorm4x8(${join(a)})` },
  unpack4x8unorm: { wgsl: (a) => `unpack4x8unorm(${join(a)})`, glsl: (a) => `unpackUnorm4x8(${join(a)})` },
  // bitcast<u32>(f) on WGSL; floatBitsToUint(f) on GLSL. The neutral id drops the
  // WGSL generic-call syntax that used to live in the IR.
  bitcastU32: { wgsl: (a) => `bitcast<u32>(${join(a)})`, glsl: (a) => `floatBitsToUint(${join(a)})` },
  // GLSL texelFetch's lod/sample arg is `int` (WGSL passes a u32 level) → wrap the
  // 3rd arg in int(); GLSL has no implicit u32→int here. (2-arg form passes through.)
  textureLoad: { wgsl: (a) => `textureLoad(${join(a)})`, glsl: (a) => a.length >= 3 ? `texelFetch(${a[0]}, ${a[1]}, int(${a[2]}))` : `texelFetch(${join(a)})` },
  // GLSL textureSize REQUIRES an int lod (WGSL textureDimensions(t) defaults to base
  // level 0); supply 0 when absent, else cast the given level to int. WGSL
  // textureDimensions returns vec2<u32> but GLSL textureSize returns a SIGNED ivec2 —
  // wrap in uvec2() so the GLSL type matches the IR's u32 type. Without this the
  // mismatch is masked while the call is inlined into an int context, but breaks the
  // moment the optimizer's CSE hoists it into a typed `uvec2 _cse = …` local.
  textureDimensions: { wgsl: (a) => `textureDimensions(${join(a)})`, glsl: (a) => a.length >= 2 ? `uvec2(textureSize(${a[0]}, int(${a[1]})))` : `uvec2(textureSize(${a[0]}, 0))` },
  // Storage-buffer emulation (WebGL2 has no SSBO): GLSL-only synthetic. A storage read
  // data[i] lowers to a fetch from a DATA TEXTURE — a[0]=the sampler, a[1]=the element index.
  // 2D-TILED: the linear index maps to (i % W, i / W) where W = the texture's own width
  // (textureSize(t,0).x), so an array wider than one texture row (>maxTextureSize) wraps
  // across rows AND the 1-row case is unchanged (W=N → i%N=i, i/N=0). The shader reads the
  // device-chosen width, so no compile-time width constant needs syncing. Only the GLSL
  // backend sees this call (the pre-pass creates it); the wgsl spelling is unused.
  storageFetchF32: { wgsl: (a) => `storageFetchF32(${join(a)})`, glsl: (a) => `texelFetch(${a[0]}, ivec2(int(${a[1]}) % textureSize(${a[0]}, 0).x, int(${a[1]}) / textureSize(${a[0]}, 0).x), 0).r` },
}

/** Spell an intrinsic / call for a target. Registry id -> mapped spelling;
 *  otherwise identity `name(args)` (portable builtins + user-defined fn calls). */
export function spellIntrinsic(target: IntrinsicTarget, name: string, args: readonly string[]): string {
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
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'exp', 'log', 'log2', 'exp2',
  'floor', 'ceil', 'abs', 'sqrt', 'fract', 'trunc', 'round', 'sign',
  'radians', 'degrees', 'normalize', 'fwidth',
  // multi-arg math — identical spelling on both targets.
  'min', 'max', 'pow', 'clamp', 'mix', 'smoothstep', 'step',
  'length', 'dot', 'distance', 'cross',
])

/** True if `name` is a builtin the registry knows how to spell on every target — either a
 *  DIVERGENT id (INTRINSICS) or an asserted-portable identity id (PORTABLE_INTRINSICS). A `call`
 *  id that is neither is EITHER a user/extern fn (fine — same spelling everywhere) OR an
 *  unclassified builtin (a latent silent-wrong-emit). The catalogue test uses this to assert the
 *  DSL's own builtin surface is fully classified. */
export const isKnownIntrinsic = (name: string): boolean =>
  Object.prototype.hasOwnProperty.call(INTRINSICS, name) || PORTABLE_INTRINSICS.has(name)
