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
  textureLoad: { wgsl: (a) => `textureLoad(${join(a)})`, glsl: (a) => `texelFetch(${join(a)})` },
  textureDimensions: { wgsl: (a) => `textureDimensions(${join(a)})`, glsl: (a) => `textureSize(${join(a)})` },
}

/** Spell an intrinsic / call for a target. Registry id -> mapped spelling;
 *  otherwise identity `name(args)` (portable builtins + user-defined fn calls). */
export function spellIntrinsic(target: IntrinsicTarget, name: string, args: readonly string[]): string {
  const entry = INTRINSICS[name]
  if (entry) return entry[target](args)
  return `${name}(${join(args)})`
}
