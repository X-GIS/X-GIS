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

/** Which emit target `spellIntrinsic` and the `INTRINSICS` table spell for — `'wgsl'` or
 *  `'glsl'`. Narrower than it looks: this is the two-column key of THIS registry's `Spelling`
 *  record, not a general backend identifier — the GLSL backend's own `Backend.id` is
 *  `'glsl-es300'`, not `'glsl'`. A future third writer (SPIR-V, MSL) needs a new column added
 *  here (and a new case in `spellIntrinsic`) before it needs anything from `core/backend.ts`.
 *
 *  Exported from `@xgis/shader-dsl`.
 */
export type IntrinsicTarget = 'wgsl' | 'glsl'

type Spelling = {
  readonly wgsl: (args: readonly string[]) => string
  readonly glsl: (args: readonly string[]) => string
}

const join = (args: readonly string[]): string => args.join(', ')

// The storage-emulation fetch, shared by the f32/u32/i32 ids below (#1703). The 2D-tiled
// index math is element-INDEPENDENT — only the sampler type the binding declares and the
// component type it fetches change. One authority so the three ids cannot drift into
// three different tilings.
//
// Spelled as a CALL to a helper the GLSL writer emits, NOT as an inline expansion (#1878).
// A template that substitutes `${a[0]}` three times and `${a[1]}` twice duplicates its
// arguments AFTER every optimizer pass has run: cse/cseLocal/gvn/licm walk the IR, and
// this text does not exist until the writer produces it, so the repetition is invisible
// to all of them by construction. It reached the baked corpus as `textureSize(t, 0).x`
// 998 times — exactly twice per fetch site — and a fetch nested inside `unpack4x8unorm`
// (itself 4x `${a[0]}`) multiplied out to four identical texelFetches in ONE expression.
// Binding the width once inside a helper is the same value with none of the repetition:
// -8.1% raw / -4.6% gzip / -3.5% brotli over the baked GLSL.
//
// Sampler-as-parameter is GLSL ES 3.00 §4.1.7, and §6.1 requires the argument to resolve
// to a uniform or another sampler parameter — so the driver must specialize the helper
// and there is no dynamic call to pay for.
//
// The index parameter is `int`, and the CALL keeps the `int(...)` cast the old template
// wrote: the lane is `u32T` on every path the storage lowering builds, but the writer is
// handed whatever Expr the caller indexed with, and a FLOAT index has no implicit
// conversion to an integer type in GLSL ES 3.00 §4.1.10 — it is a compile error, which
// is what a `uint i` parameter turned `data[uv.x * 3.0]` into. Casting once at the call
// site is both the old semantics exactly (`int(-1.5)` is -1, where `uint(-1.5)` is
// undefined) and still one cast instead of the template's two.
const storageFetchDef = (ret: string, samp: string, fn: string): string =>
  `${ret} ${fn}(${samp} t, int i) {\n  int w = textureSize(t, 0).x;\n  return texelFetch(t, ivec2(i % w, i / w), 0).r;\n}`

const storageFetchGlsl =
  (fn: string) =>
  (a: readonly string[]): string =>
    `${fn}(${a[0]}, int(${a[1]}))`

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
  // textureSampleLevel(tex, samp, uv, level) — explicit-LOD sample; same tex+samp
  // fusion as textureSample, so the sampler arg (a[1]) is dropped on GLSL.
  // LOAD-BEARING (#1650 decision): the array / offset / bias variants must each take
  // a NEW neutral id (#1651 adds textureSampleLevelArray) — NEVER an arity branch on
  // this entry. A spelling that switches on args.length makes the id's meaning depend
  // on the call site, which is exactly the WGSL leak the registry exists to prevent.
  textureSampleLevel: {
    wgsl: (a) => `textureSampleLevel(${join(a)})`,
    glsl: (a) => `textureLod(${a[0]}, ${a[2]}, ${a[3]})`,
  },
  // ── 2d-array sampling (#1651) — DISTINCT ids, never an arity branch above ──
  //
  // textureSampleArray(tex, samp, uv, layer). WGSL keeps the ARRAY as a separate
  // argument (`textureSample(t, s, uv, layer)`); GLSL ES 3.00 has no array-specific
  // spelling at all — the layer rides in the coordinate's THIRD component
  // (`texture(sampler2DArray, vec3(uv, layer))`), which is exactly why this cannot be
  // an args.length branch on textureSample: the two ids restructure the arguments
  // differently, they do not merely add one.
  textureSampleArray: {
    wgsl: (a) => `textureSample(${join(a)})`,
    // a[1] (the sampler) fuses away; float() because GLSL ES has no implicit
    // int→float at a constructor component (the registry's existing cast convention).
    glsl: (a) => `texture(${a[0]}, vec3(${a[2]}, float(${a[3]})))`,
  },
  // textureSampleLevelArray(tex, samp, uv, layer, level) — the any-stage array read
  // (an explicit LOD needs no derivatives, so it is legal in vertex/compute too).
  textureSampleLevelArray: {
    wgsl: (a) => `textureSampleLevel(${join(a)})`,
    glsl: (a) => `textureLod(${a[0]}, vec3(${a[2]}, float(${a[3]})), ${a[4]})`,
  },
  // textureLoadArray(tex, coord, layer, level) — unfiltered texel fetch. GLSL folds
  // the layer into an ivec3 coordinate; the lod arg is `int` (WGSL passes u32).
  textureLoadArray: {
    wgsl: (a) => `textureLoad(${join(a)})`,
    glsl: (a) => `texelFetch(${a[0]}, ivec3(${a[1]}, int(${a[2]})), int(${a[3]}))`,
  },
  atan2: { wgsl: (a) => `atan2(${join(a)})`, glsl: (a) => `atan(${join(a)})` },
  // round(x) — ties-to-EVEN on both targets. WGSL's round IS roundEven; GLSL ES
  // 3.00's own round() leaves the 0.5 case IMPLEMENTATION-CHOSEN (§8.3 "the
  // fraction 0.5 will round in a direction chosen by the implementation"), so
  // the identity spelling was a latent cross-backend divergence on exact halves.
  // roundEven (also ES 3.00 §8.3) is the one GLSL spelling whose semantics are
  // guaranteed to agree with WGSL — and with the CPU oracle's roundTiesToEven.
  round: { wgsl: (a) => `round(${join(a)})`, glsl: (a) => `roundEven(${join(a)})` },
  // saturate(x) — clamp to [0,1], component-wise. WGSL has the dedicated
  // builtin; GLSL ES 3.00 has none, so it inlines as the clamp both specs
  // define saturate to be. The scalar 0.0/1.0 bounds broadcast over vector x
  // (GLSL's clamp(genType, float, float) overload).
  saturate: { wgsl: (a) => `saturate(${join(a)})`, glsl: (a) => `clamp(${a[0]}, 0.0, 1.0)` },
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
  // ── 2×16 pack/unpack — NATIVE on both targets, divergent NAME only ──
  // WGSL pack2x16float/unorm/snorm ↔ GLSL ES 3.00 packHalf2x16 / packUnorm2x16 /
  // packSnorm2x16 (§8.4): identical bit layout (component 0 in the 16 LOW bits)
  // and identical quantisation formulas, so unlike the 4×8 pair below (ES 3.10-
  // only, hand-inlined) these six are straight renames.
  pack2x16float: {
    wgsl: (a) => `pack2x16float(${join(a)})`,
    glsl: (a) => `packHalf2x16(${join(a)})`,
  },
  unpack2x16float: {
    wgsl: (a) => `unpack2x16float(${join(a)})`,
    glsl: (a) => `unpackHalf2x16(${join(a)})`,
  },
  pack2x16unorm: {
    wgsl: (a) => `pack2x16unorm(${join(a)})`,
    glsl: (a) => `packUnorm2x16(${join(a)})`,
  },
  unpack2x16unorm: {
    wgsl: (a) => `unpack2x16unorm(${join(a)})`,
    glsl: (a) => `unpackUnorm2x16(${join(a)})`,
  },
  pack2x16snorm: {
    wgsl: (a) => `pack2x16snorm(${join(a)})`,
    glsl: (a) => `packSnorm2x16(${join(a)})`,
  },
  unpack2x16snorm: {
    wgsl: (a) => `unpack2x16snorm(${join(a)})`,
    glsl: (a) => `unpackSnorm2x16(${join(a)})`,
  },
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
  // 2d-array (#1651) needs NO array-specific id here: WGSL textureDimensions returns
  // vec2<u32> for an array texture too (the layer count is textureNumLayers), and
  // GLSL's textureSize(sampler2DArray, lod) returns an ivec3 whose extra component the
  // uvec2() constructor legally DROPS (GLSL ES 3.00 §5.4.2). Escape hatch if a driver
  // ever objects: spell the truncation explicitly as `uvec2(textureSize(t, l).xy)`.
  textureDimensions: {
    wgsl: (a) => `textureDimensions(${join(a)})`,
    glsl: (a) =>
      a.length >= 2
        ? `uvec2(textureSize(${a[0]}, int(${a[1]})))`
        : `uvec2(textureSize(${a[0]}, 0))`,
  },
  // textureNumLayers(t) — the layer COUNT of a 2d-array texture (#1658), i.e. the
  // ivec3 component the entry above deliberately DROPS. Its own id, not an overload
  // of textureDimensions: WGSL has a dedicated function, GLSL ES 3.00 has none and
  // reads `.z` off textureSize. GLSL's textureSize REQUIRES a lod argument, and the
  // layer count is LOD-INVARIANT (a mip reduces width/height only — depth stays N),
  // so 0 is always correct here regardless of the level the caller cares about. The
  // uint() wrap matches the IR's u32 type, same reason as the uvec2() above: the
  // signed ivec3 would be an int/uint compile error once CSE hoists the call into a
  // typed `uint _cse = …` local.
  textureNumLayers: {
    wgsl: (a) => `textureNumLayers(${join(a)})`,
    glsl: (a) => `uint(textureSize(${a[0]}, 0).z)`,
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
    glsl: storageFetchGlsl('_sfetch'),
  },
  // The INTEGER twins (#1703) — the TYPED-texture leg of the same emulation, for a
  // top-level array<u32> / array<i32>. The index math is identical (hence the shared
  // spelling above); what differs is the sampler the binding declares — usampler2D /
  // isampler2D over an R32UI / R32I data texture — and therefore the type of the
  // fetched vec. That difference rides a DISTINCT ID rather than a type branch on one
  // id, the same rule the textureSample/textureSampleArray split follows.
  //
  // Why typed textures and not u32-lanes-bitcast-through-R32F: GLSL ES 3.00 §2.1.1
  // permits flushing ANY denormal to zero, and small integers are denormal f32 bit
  // patterns (1u is 1.4e-45), so the bitcast route can legally lose values. Exactness
  // is the entire point of an integer array.
  storageFetchU32: {
    wgsl: (a) => `storageFetchU32(${join(a)})`,
    glsl: storageFetchGlsl('_sfetchU'),
  },
  storageFetchI32: {
    wgsl: (a) => `storageFetchI32(${join(a)})`,
    glsl: storageFetchGlsl('_sfetchI'),
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
/** Which binding name(s) an intrinsic's SPELLING references TEXTUALLY, for the one intrinsic
 *  (`f64Guard`) that names a binding inside its emitted string rather than through an `Expr`
 *  argument — normal reference collection over the IR (`ir/collect-refs`) has no argument node
 *  to walk, so it cannot see this reference at all. The real consumer is the GLSL per-stage emit
 *  scope (`backends/glsl.ts` `stageScope`): it keeps only the bindings a reachable function
 *  varrefs, then adds this table's entries for every INTRINSIC CALL it kept, so `_fp64` survives
 *  stage-trimming even though nothing in the IR names it directly. Any new intrinsic that
 *  hardcodes a binding name into its spelling (the way `f64Guard` hardcodes `_fp64`) MUST add a
 *  row here, or per-stage emit will drop the binding while the spelling still reads it — a GLSL
 *  compile error naming an undeclared sampler, not caught until a real WebGL2 driver sees it.
 *
 *  Exported from `@xgis/shader-dsl`.
 */
export const INTRINSIC_BINDING_REFS: Readonly<Record<string, readonly string[]>> = {
  f64Guard: ['_fp64'],
}

// ── Spelling-provided helper functions ──
//
// The sibling of the table above: there, an intrinsic's spelling REFERENCES a name the
// unit must declare anyway; here, it references a name the unit must DEFINE, and the
// definition ships with the spelling so the two cannot drift.
//
// Each entry is a leaf — it calls only builtins — so a consumer may emit the definitions
// in any order at the top of its function section with no prototype and no dependency
// sort. `fn` is the name the spelling calls, exposed so a consumer can assert the pairing
// rather than re-derive it from the definition text.
/** Helper function(s) an intrinsic's GLSL SPELLING calls, for the intrinsics that emit a
 *  call rather than an inline expansion (#1878). The GLSL writer must emit `def` for every
 *  such intrinsic a reachable function calls — the same reachability walk `stageScope`
 *  already runs for bindings — or the spelling calls a function the unit never defines.
 *  Emitting an entry nothing calls is a size regression, not a compile error, so the writer
 *  keys off the calls it actually collected rather than off the module's bindings.
 *
 *  Only the GLSL column has entries: WGSL indexes storage buffers directly and spells no
 *  helper. Exported from `@xgis/shader-dsl`.
 */
export const INTRINSIC_HELPERS: Readonly<
  Record<string, { readonly fn: string; readonly def: string }>
> = {
  storageFetchF32: { fn: '_sfetch', def: storageFetchDef('float', 'sampler2D', '_sfetch') },
  storageFetchU32: { fn: '_sfetchU', def: storageFetchDef('uint', 'usampler2D', '_sfetchU') },
  storageFetchI32: { fn: '_sfetchI', def: storageFetchDef('int', 'isampler2D', '_sfetchI') },
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
/** The builtin ids asserted to spell IDENTICALLY on both targets — `sin`, `dot`, `clamp`, and
 *  friends — so they carry no `INTRINSICS` entry and fall through `spellIntrinsic` as the plain
 *  `name(args)` identity. This set itself is never consulted BY `spellIntrinsic` (which only
 *  reads `INTRINSICS`); it exists so `isKnownIntrinsic` can tell "deliberately identical" apart
 *  from "nobody has classified this yet" — and that distinction is load-bearing at RUNTIME, not
 *  just in the coverage test: `fp64Lower` calls `isKnownIntrinsic` while walking f64 operands
 *  (e.g. to reject an unsupported builtin over a `mat64` value), so a new divergent builtin
 *  added here BY MISTAKE would silently emit the same (wrong-on-one-target) string instead of
 *  failing the catalogue test that actually catches it.
 *
 *  Exported from `@xgis/shader-dsl`.
 */
export const PORTABLE_INTRINSICS: ReadonlySet<string> = new Set([
  // genType1 (component-wise unary) — same name in WGSL + GLSL ES 3.00.
  'sin',
  'cos',
  'tan',
  'asin',
  'acos',
  'atan',
  // Hyperbolics — WGSL §17.5 and GLSL ES 3.00 §8.1 both spell all six natively.
  'sinh',
  'cosh',
  'tanh',
  'asinh',
  'acosh',
  'atanh',
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
  // 'round' moved to INTRINSICS: GLSL ES 3.00's round() is implementation-chosen
  // at exact halves, so it now spells roundEven there (see the registry entry).
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
/** Builtin ids the authoring surface can produce that are consumed ENTIRELY by `fp64Lower`
 *  before any backend ever runs — the f64 widen/pack/unpack trio. Unlike `PORTABLE_INTRINSICS`
 *  (which DOES reach `spellIntrinsic`, just spelled identically), these are rewritten away
 *  during lowering and must NEVER survive to it: `isKnownIntrinsic` deliberately excludes them,
 *  so if one leaks through unlowered, the backend's type-spelling backstop (`wgslType`/
 *  `glslType`, error code SD0040) catches it loudly instead of emitting an invalid call the
 *  driver would reject with no line back to the authoring site.
 *
 *  Exported from `@xgis/shader-dsl`.
 */
export const PRE_EMIT_INTRINSICS: ReadonlySet<string> = new Set(['f64', 'f64FromParts', 'f64Parts'])

/** True if `name` is a builtin the registry knows how to spell on every target — either a
 *  DIVERGENT id (INTRINSICS) or an asserted-portable identity id (PORTABLE_INTRINSICS). A `call`
 *  id that is neither is EITHER a user/extern fn (fine — same spelling everywhere) OR an
 *  unclassified builtin (a latent silent-wrong-emit). The catalogue test uses this to assert the
 *  DSL's own builtin surface is fully classified. (PRE_EMIT_INTRINSICS ids are deliberately NOT
 *  "known" here — they are unspellable by construction.) */
export const isKnownIntrinsic = (name: string): boolean =>
  Object.prototype.hasOwnProperty.call(INTRINSICS, name) || PORTABLE_INTRINSICS.has(name)
