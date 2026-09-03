// ═══ Shader DSL — IR types ═══
//
// ShaderType (the runtime type descriptor), the branded type constants, the
// type-level key machinery (KeyOf/ElemKey/ScalarKey) that powers the
// compile-time type-safety gate, and the type predicates/helpers. No Node
// dependency — this is the leaf of the core/ir import DAG
// (types ← nodes ← node ← builder).

/** The four native scalar kinds — the ones WGSL and GLSL ES 3.00 both represent directly in
 *  hardware, and the set `ShaderType`'s `{ kind: 'scalar' }` arm can carry. Drives the native
 *  promotion order in binary-op type resolution (`f32` > `i32` > `u32`, `node.ts`'s
 *  `binResultType`). `'f64'` is deliberately NOT a member: it is emulated (lowers to a
 *  `vec2<f32>` pair before emit) and has its OWN `ShaderType.kind` for that reason — see
 *  {@link ShaderType} — so it never enters native promotion and every scalar-kind switch is
 *  forced to decide about it separately.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 */
export type Scalar = 'f32' | 'i32' | 'u32' | 'bool'

/** The element type of a SAMPLED texture (#1703) — WGSL's `texture_2d<T>` type
 *  parameter, GLSL ES 3.00's sampler prefix (`f32` → `sampler2D`, `u32` →
 *  `usampler2D`, `i32` → `isampler2D`). All three are CORE in both targets.
 *
 *  An INTEGER texture is UNFILTERABLE: interpolating integer texels is undefined, so
 *  WGSL rejects `textureSample` on `texture_2d<u32>` at the spec level. GLSL's
 *  `texture(usampler2D, …)` would work (NEAREST), but wiring it up would mint a
 *  construct that compiles on WebGL2 and cannot be expressed on WebGPU at all —
 *  which is exactly what authoring once and emitting both targets is meant to rule
 *  out. The honest intersection is `textureLoad` + `textureDimensions` +
 *  `textureNumLayers`; `textureSample`/`textureSampleLevel` fail at tsc on an integer
 *  key (pinned by dx-sweep.test.ts). */
export type TextureElem = 'f32' | 'u32' | 'i32'

/** The runtime type descriptor for every value the DSL can represent — a plain, comparable
 *  discriminated union (never a class or a branded object), so a `switch (t.kind)` over it is
 *  exhaustively checked by `tsc` at each site that must decide what to do with a shape
 *  ({@link typeKey}, `wgslLayout`, both backends' emit walkers). Don't build one as a literal —
 *  use the named constants below (`f32T`, `vec3fT`, …) or the `structT` / `arrayT`
 *  constructors, which keep the `as const satisfies ShaderType` narrowing that {@link KeyOf}
 *  depends on to resolve a precise string key instead of `string`. `typeKey` turns any
 *  `ShaderType` into that same key at runtime; `KeyOf<T>` is its type-level mirror, letting
 *  `Node<K>` (the authoring wrapper) carry the key as a compile-time phantom so a type
 *  mismatch is a `tsc` error instead of an `SD0002` thrown at author-run time.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 */
export type ShaderType =
  | { readonly kind: 'scalar'; readonly scalar: Scalar }
  // Emulated double precision (df64): a LOGICAL scalar that lowers to a
  // vec2<f32> (x = hi, y = lo) before emit (passes/fp64-lower.ts). Its OWN kind
  // — not a Scalar — so it never participates in the native scalar promotion
  // (binResultType) and every `t.kind` switch is forced to decide about it.
  | { readonly kind: 'f64' }
  // A vector of emulated doubles: lowers to `struct DF64VecN { hi: vecN<f32>,
  // lo: vecN<f32> }` before emit — the EFTs are lane-valid, so componentwise
  // arithmetic runs on whole vecN hi/lo planes. Own kind, same rationale.
  | { readonly kind: 'vec64'; readonly n: 2 | 3 | 4 }
  | { readonly kind: 'vec'; readonly n: 2 | 3 | 4; readonly elem: 'f32' | 'i32' | 'u32' }
  // A matrix. elem 'f32' is native (matNxN<f32>); elem 'f64' is emulated double
  // precision — it lowers to `struct DF64MatN { c0..c(N-1): DF64VecN }` (columns
  // of df64), and matmul / mat·vec / transpose compose the SCALAR df64 EFTs the
  // same way length/dot do. Own elem arm, so every `t.kind === 'mat'` consumer is
  // forced to decide about f64 (verified-by-construction).
  | { readonly kind: 'mat'; readonly n: 2 | 3 | 4; readonly elem: 'f32' | 'f64' }
  | { readonly kind: 'struct'; readonly name: string }
  | { readonly kind: 'array'; readonly elem: ShaderType; readonly size?: number }
  // A sampled texture. '2d-array' (#1651) is CORE in both targets — WGSL
  // texture_2d_array<f32>, GLSL ES 3.00 sampler2DArray — so it needs no Capability
  // (pinned by required-caps.test.ts); '2d-ms' still fails closed on GLSL.
  //
  // Split into TWO arms (#1703) so a multisampled INTEGER texture is unrepresentable
  // by CONSTRUCTION rather than a runtime throw: '2d'/'2d-array' carry any
  // TextureElem, '2d-ms' is pinned to f32. Narrowing still works off `dim` alone —
  // every existing `t.dim === '…'` switch reads the same.
  | { readonly kind: 'texture'; readonly dim: '2d' | '2d-array'; readonly elem: TextureElem }
  | { readonly kind: 'texture'; readonly dim: '2d-ms'; readonly elem: 'f32' }
  | { readonly kind: 'sampler' }
  | { readonly kind: 'void' }

// `as const satisfies` keeps each constant's LITERAL type (so KeyOf<typeof f32T>
// resolves to the precise key 'f32' / 'vec2<f32>' …) while still checking it is
// a valid ShaderType — the basis for the compile-time type-safety gate (AC4).
/** The `f32` scalar type — the DSL's default numeric type: what a bare numeric literal lifts
 *  to (`lift(3)` → `Node<'f32'>`), and what most builtins (`sin`, `mix`, `length`, …) return.
 *  Use it to type an `fn` parameter, a `resource`/uniform field, or a struct field that must
 *  hold a native float rather than the emulated {@link f64T}.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 */
export const f32T = { kind: 'scalar', scalar: 'f32' } as const satisfies ShaderType
/** The emulated-double-precision scalar type (df64) — a LOGICAL `f64`, not a native GPU type:
 *  it lowers to a `vec2<f32>` (hi/lo error-free-transform pair) before emit
 *  (`passes/fp64-lower.ts`), so a value typed `f64T` costs one native `f32` pair, not a real
 *  64-bit register. Its own `ShaderType.kind` (not a {@link Scalar}) keeps it out of native
 *  scalar promotion and forces every `t.kind` switch to decide about it. Reach for it only
 *  when f32's ~7 decimal digits aren't enough — deep-zoom world coordinates, long-running
 *  clocks — never as a general "more precision" default; it costs several f32 ops per f64 op.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 */
export const f64T = { kind: 'f64' } as const satisfies ShaderType
/** A 2-component emulated-double vector (`vec2<f64>` logically), lowered to a
 *  `struct DF64Vec2 { hi: vec2<f32>, lo: vec2<f32> }` before emit — componentwise arithmetic
 *  runs on the whole hi/lo plane rather than per-scalar df64 ops. The usual carrier for a
 *  deep-zoom world-space point (see the `shader-dsl/examples/fp64-*.ts` gallery, e.g.
 *  `fp64-mandelbrot.ts`'s `center: vec2f64T` uniform) that must survive far more than f32's
 *  ~7 significant digits.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 */
export const vec2f64T = { kind: 'vec64', n: 2 } as const satisfies ShaderType
/** A 3-component emulated-double vector — see {@link vec2f64T} for the lowering and when to
 *  reach for the df64 family over plain {@link vec3fT}.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 */
export const vec3f64T = { kind: 'vec64', n: 3 } as const satisfies ShaderType
/** A 4-component emulated-double vector — see {@link vec2f64T} for the lowering and when to
 *  reach for the df64 family over plain {@link vec4fT}.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 */
export const vec4f64T = { kind: 'vec64', n: 4 } as const satisfies ShaderType
/** The `i32` scalar type — the DSL's signed-integer type. Types the target of the `i32(...)`
 *  cast (`node.ts`) and the scrutinee `match-lower.ts` casts a non-integer `matchExpr` value
 *  to, since WGSL's `switch` only accepts integer scrutinees. Use it for signed-integer `fn`
 *  parameters and fields; for an unsigned count or index, prefer {@link u32T}.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 */
export const i32T = { kind: 'scalar', scalar: 'i32' } as const satisfies ShaderType
/** The `u32` scalar type — the DSL's unsigned-integer type, used for counts, indices, and
 *  compute/vertex builtins that are unsigned by spec (`builtin('vertex_index', u32T)` in
 *  `shader-dsl/examples/_fullscreen.ts`, `builtin('global_invocation_id', vec3uT)` for the
 *  vector form). Reach for it over {@link i32T} whenever the value can never be negative — it
 *  documents the invariant at the type.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 */
export const u32T = { kind: 'scalar', scalar: 'u32' } as const satisfies ShaderType
/** The `bool` scalar type — the type of every comparison (`.lt`, `.eq`, …) and logical
 *  (`.and`, `.or`) result, and the required return type of a boolean-returning `fn` (e.g.
 *  `map/src/shaders/dsl/coverage-filter.ts`'s `fn(COVERAGE_FILTER_FN, { … }, boolT, …)`, and
 *  the type `If`/`Switch` guards check against at author-run time).
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 */
export const boolT = { kind: 'scalar', scalar: 'bool' } as const satisfies ShaderType
/** A native `vec2<f32>` — the most common vector type in the DSL: screen/UV coordinates and
 *  2D positions. Types the `uv: location(0, vec2fT)` fragment-input field and the
 *  `resolution: vec2fT` uniform shared by every example in `shader-dsl/examples/_fullscreen.ts`.
 *  Pair with the `vec2` literal constructor to build a value; use {@link vec2f64T} instead when
 *  the value must survive more precision than f32 offers.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 */
export const vec2fT = { kind: 'vec', n: 2, elem: 'f32' } as const satisfies ShaderType
/** A native `vec3<f32>` — the usual carrier for a world-space position or direction (e.g.
 *  `shader-dsl/examples/raymarch-boxes.ts`'s `scene(p: vec3fT)`, or the split ECEF
 *  high/low fields `ecefH: vec3fT, ecefL: vec3fT` in `map/src/shaders/dsl/arrow-retained.ts`).
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 */
export const vec3fT = { kind: 'vec', n: 3, elem: 'f32' } as const satisfies ShaderType
/** A native `vec4<f32>` — RGBA colour or homogeneous clip-space position; types the
 *  `pos: builtin('position', vec4fT)` vertex-output field and `location(0, vec4fT)`
 *  fragment-output field that recur across the `shader-dsl/examples/*` gallery, and any RGBA
 *  uniform field (`mouse: vec4fT` in `julia.ts`).
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 */
export const vec4fT = { kind: 'vec', n: 4, elem: 'f32' } as const satisfies ShaderType
/** A native `vec2<u32>` — a 2-wide unsigned-integer field, e.g. a packed pick-ID varying
 *  (`location(1, vec2uT, 'flat')` in `map/src/shaders/dsl/hillshade.ts` and `line.ts`).
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 */
export const vec2uT = { kind: 'vec', n: 2, elem: 'u32' } as const satisfies ShaderType
/** A native `vec3<u32>` — chiefly the type of the WGSL/GLSL compute `global_invocation_id`
 *  builtin (`builtin('global_invocation_id', vec3uT)` in
 *  `shader-dsl/examples/compute-reduction.ts`).
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 */
export const vec3uT = { kind: 'vec', n: 3, elem: 'u32' } as const satisfies ShaderType
/** A native `vec4<u32>` — a 4-wide unsigned-integer resource/uniform field (e.g. compute
 *  reduction parameters, `resource('params', vec4uT, { … })` in
 *  `shader-dsl/examples/compute-reduction.ts`).
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 */
export const vec4uT = { kind: 'vec', n: 4, elem: 'u32' } as const satisfies ShaderType
/** A native `vec2<i32>` — pairs with the `vec2i(...)` literal constructor (`node.ts`) to build
 *  a signed-integer 2-vector, e.g. a texel coordinate for `textureLoad`.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 */
export const vec2iT = { kind: 'vec', n: 2, elem: 'i32' } as const satisfies ShaderType
/** A native `vec4<i32>` — completes the signed-integer vector family alongside
 *  {@link vec2iT}; use it to TYPE an `fn` parameter, `resource`, or struct field declared as
 *  `vec4<i32>` (there is no `vec4i(...)` literal constructor — author the value via
 *  `construct`/`.at()` against this type instead).
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 */
export const vec4iT = { kind: 'vec', n: 4, elem: 'i32' } as const satisfies ShaderType
/** A native `mat4x4<f32>` — the only native f32 matrix size the DSL exposes a named constant
 *  for (no `mat2x2fT`/`mat3x3fT`; `reflect.ts` notes mat2 std140 layout diverges between WGSL
 *  and real GLSL and is rejected until that dual-rule layout lands). This is the MVP/view
 *  matrix type throughout `map/src/shaders/dsl/*` (`mvp: mat4x4fT` in `raster.ts`, `line.ts`,
 *  `polygon.ts`, `point.ts`, …) and `map/src/render/frame-uniform.ts`'s per-frame uniform.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 */
export const mat4x4fT = { kind: 'mat', n: 4, elem: 'f32' } as const satisfies ShaderType
/** A 2×2 emulated-double matrix (`mat2x2<f64>` logically) — lowers to
 *  `struct DF64Mat2 { c0: DF64Vec2, c1: DF64Vec2 }` before emit, and `matmul` / mat·vec /
 *  `transpose` on it compose the scalar df64 error-free transforms the same way
 *  {@link vec2f64T}'s `length`/`dot` do. See `core/fp64/mat64.test.ts` for worked
 *  `transformMat64` / `mulMat64` / `transpose64` calls against this type.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 */
export const mat2f64T = { kind: 'mat', n: 2, elem: 'f64' } as const satisfies ShaderType
/** A 3×3 emulated-double matrix — see {@link mat2f64T} for the lowering and the df64 matrix
 *  ops available against it.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 */
export const mat3f64T = { kind: 'mat', n: 3, elem: 'f64' } as const satisfies ShaderType
/** A 4×4 emulated-double matrix — see {@link mat2f64T} for the lowering and the df64 matrix
 *  ops available against it.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 */
export const mat4f64T = { kind: 'mat', n: 4, elem: 'f64' } as const satisfies ShaderType
/** A sampled 2D texture (WGSL `texture_2d<f32>`, GLSL ES 3.00 `sampler2D`) — the ordinary
 *  single-layer binding type behind `textureSample`/`textureLoad`, used throughout
 *  `map/src/shaders/dsl/*` for colour ramps, flow fields, and atlases (`resource('atlas_tex',
 *  texture2dfT, { … })` in `icon-retained.ts`, `coverage-ramp.ts`, `flow-advect.ts`, …). Every
 *  texture kind in this DSL hardcodes `elem: 'f32'` — there is no integer sampled-texture
 *  variant yet (#1703); don't author or document one as if it exists.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 */
export const texture2dfT = { kind: 'texture', dim: '2d', elem: 'f32' } as const satisfies ShaderType
/** A multisampled 2D texture (WGSL `texture_multisampled_2d<f32>`, GLSL
 *  `sampler2DMS`) — the resolve-source binding for an MSAA render target, read one sample at a
 *  time via `textureLoad(tex, coord, sampleIndex)` inside a per-sample averaging loop rather
 *  than filtered-sampled. `map/src/shaders/dsl/oit-compose.ts` picks this type over
 *  {@link texture2dfT} at emit time based on `sampleCount > 1` (`isMsaa ? texture2dMsfT :
 *  texture2dfT`) so the same shader source handles both the MSAA and single-sample path.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 */
export const texture2dMsfT = {
  kind: 'texture',
  dim: '2d-ms',
  elem: 'f32',
} as const satisfies ShaderType
/** A sampled 2D ARRAY texture (#1651) — one texture object, N independently
 *  addressable layers (a tile atlas, a glyph page set, a per-layer LUT stack).
 *  The layer is a per-sample ARGUMENT, not a binding, so N layers cost one
 *  binding slot and one bind-group switch. */
export const texture2dArrayfT = {
  kind: 'texture',
  dim: '2d-array',
  elem: 'f32',
} as const satisfies ShaderType
/** An UNSIGNED-integer 2D texture (#1703) — WGSL `texture_2d<u32>`, GLSL ES 3.00
 *  `usampler2D`. Read with {@link textureLoad} (→ `vec4<u32>`); it carries EXACT
 *  32-bit values, which is what makes it the right backing for an id / packed-colour
 *  / bitfield lookup that must survive the trip to the GPU unchanged. Unfilterable —
 *  `textureSample` on it is a tsc error, by design (see {@link TextureElem}). */
export const texture2duT = { kind: 'texture', dim: '2d', elem: 'u32' } as const satisfies ShaderType
/** A SIGNED-integer 2D texture (#1703) — WGSL `texture_2d<i32>`, GLSL ES 3.00
 *  `isampler2D`. The signed twin of {@link texture2duT}; same load-only contract. */
export const texture2diT = { kind: 'texture', dim: '2d', elem: 'i32' } as const satisfies ShaderType
/** An UNSIGNED-integer 2D ARRAY texture (#1703) — WGSL `texture_2d_array<u32>`,
 *  GLSL ES 3.00 `usampler2DArray`. {@link texture2dArrayfT}'s layer model with
 *  {@link texture2duT}'s exact-integer texels. */
export const texture2dArrayuT = {
  kind: 'texture',
  dim: '2d-array',
  elem: 'u32',
} as const satisfies ShaderType
/** A SIGNED-integer 2D ARRAY texture (#1703) — WGSL `texture_2d_array<i32>`,
 *  GLSL ES 3.00 `isampler2DArray`. */
export const texture2dArrayiT = {
  kind: 'texture',
  dim: '2d-array',
  elem: 'i32',
} as const satisfies ShaderType
/** The sampler resource type (WGSL `sampler`, GLSL's implicit combined-sampler half) — always
 *  paired with a texture type ({@link texture2dfT} et al.) as a separate `resource()` binding;
 *  `textureSample`/`textureSampleLevel` take both. See `resource('atlas_sampler', samplerT, {
 *  group: 0, binding: 1 })` in `shader-dsl/examples/texture-array-lod.ts`.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 */
export const samplerT = { kind: 'sampler' } as const satisfies ShaderType
/** The absent-value type — the return type of an `fn` whose body never returns a value (a
 *  statement-only vertex mutator, a compute entry point). `inferReturnType`
 *  (`core/ir/builder.ts`) falls back to this when it walks every `Return` in a body and finds
 *  none; you should rarely need to write it explicitly, since an author normally lets the
 *  return-type token be inferred.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 */
export const voidT = { kind: 'void' } as const satisfies ShaderType
/** Builds the `ShaderType` for a named struct — the type you pass wherever a struct-typed
 *  value is authored (a `b.var(name, structT('VsOut'))` local, an `fn` parameter, an array
 *  element via {@link arrayT}). Two calls with the same `name` compare equal under
 *  {@link typeKey}/{@link typeEq} regardless of identity, since the key is the name string, not
 *  the struct's field list — the DSL never checks field shape here. Prefer the higher-level
 *  `ioStruct`/`sotStruct` declarators (`AUTHORING.md`) for new code, which return a typed
 *  accessor built on top of this; reach for `structT` directly only when you already have a
 *  `StructDecl` and need its bare `ShaderType`.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 *
 *  @example
 *  ```ts
 *  import { structT, typeEq } from '@xgis/shader-dsl'
 *
 *  // Equality is by NAME only — no field-shape check happens here.
 *  typeEq(structT('DF64Vec2'), structT('DF64Vec2')) // true
 *  ```
 */
export const structT = <N extends string>(
  name: N,
): { readonly kind: 'struct'; readonly name: N } => ({
  kind: 'struct',
  name,
})
/** Array type; pass `size` for a fixed-length WGSL array (`array<T, N>`). Both `elem` and
 *  `size` are preserved as literals so {@link KeyOf} can spell the exact `array<…>` key
 *  {@link typeKey} produces (#2456). */
export const arrayT = <E extends ShaderType, S extends number | undefined = undefined>(
  elem: E,
  size?: S,
): { readonly kind: 'array'; readonly elem: E; readonly size: S } => ({
  kind: 'array',
  elem,
  size: size as S,
})

// Type-level key of a ShaderType literal — the phantom carried by Node<K>.
/** Turns a `ShaderType` LITERAL into the precise string key `Node<K>` carries as its
 *  compile-time phantom — `KeyOf<typeof vec3fT>` resolves to the literal `'vec3<f32>'`, not
 *  `string`, which is what lets a `vec2`+`vec3` operand mismatch fail `tsc` instead of only the
 *  runtime `SD0002` check `typeKey`/`typeEq` perform. This only narrows correctly against a
 *  `T` that kept its literal shape (the `as const satisfies ShaderType` constants in this file,
 *  or `structT`/`arrayT` results) — a widened `ShaderType` collapses to the `string` fallback
 *  arm. Every arm here must stay byte-identical to {@link typeKey}'s switch; a new `ShaderType`
 *  variant needs a new arm in BOTH.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 *
 *  @typeParam T — the `ShaderType` (or a subset of it) to resolve a key for.
 */
export type KeyOf<T> = T extends { kind: 'scalar'; scalar: infer S extends string }
  ? S
  : T extends { kind: 'f64' }
    ? 'f64'
    : T extends { kind: 'vec64'; n: infer N extends number }
      ? `vec${N}<f64>`
      : T extends { kind: 'vec'; n: infer N extends number; elem: infer E extends string }
        ? `vec${N}<${E}>`
        : T extends { kind: 'mat'; n: infer N extends number; elem: infer E extends string }
          ? `mat${N}x${N}<${E}>`
          : // #2456 — struct / array / void arms. typeKey has emitted `struct:Name`,
            // `array<K,N>` and `void` since forever; KeyOf had no arm for any of them, so
            // every struct-typed and array-typed node fell through to the `string` fallback
            // — the phantom key that swallowed `construct`, `arrayLit` and both struct
            // declarators' `.construct` (D4.1 in docs/plans/2026-09-01-…).
            T extends { kind: 'struct'; name: infer N extends string }
            ? `struct:${N}`
            : T extends { kind: 'array'; elem: infer E; size: infer S }
              ? S extends number
                ? `array<${KeyOf<E>},${S}>`
                : `array<${KeyOf<E>}>`
              : T extends { kind: 'void' }
                ? 'void'
                : // #763 X6 — texture/sampler arms (spellings match typeKey()): resource()
                  // promised a SPECIFIC key (`Node<'texture_2d<f32>'>`) but these fell through
                  // to `string`, so a texture/sampler argument swap type-checked.
                  T extends { kind: 'texture'; dim: '2d-ms' }
                  ? 'texture_multisampled_2d<f32>'
                  : // #1651 — arm ORDER is immaterial here: the dims are exact literals, so
                    // `{ dim: '2d-array' }` never extends `{ dim: '2d' }` regardless of which
                    // arm comes first. The real hazard is a MISSING arm — it drops an array
                    // resource() node through to the `string` fallback, where it matches no
                    // authoring overload at all (the failure is a confusing "no overload
                    // matches", not a key mismatch).
                    // #1703 — `elem` is INFERRED, not hardcoded to f32: a texture2duT resource
                    // must land on `texture_2d<u32>`, and a hardcoded `<f32>` would silently
                    // hand an integer texture the FLOAT key, where textureSample's overload
                    // accepts it and naga rejects the emitted WGSL.
                    T extends { kind: 'texture'; dim: '2d-array'; elem: infer E extends string }
                    ? `texture_2d_array<${E}>`
                    : T extends { kind: 'texture'; dim: '2d'; elem: infer E extends string }
                      ? `texture_2d<${E}>`
                      : T extends { kind: 'sampler' }
                        ? 'sampler'
                        : string
/** Element key of a vector key (`vec3<u32>` → `u32`); identity for scalars. */
export type ElemKey<K extends string> = K extends `vec${number}<${infer E}>` ? E : K
/** The `KeyOf` string form of {@link Scalar}, minus `'bool'` — the key set accepted wherever
 *  the DSL needs an indexable/comparable native scalar: array indices (`.at(i:
 *  ReadonlyNode<ScalarKey> | number, …)`), bitwise-op operands, and `matchExpr`/`Switch`
 *  scrutinees. `'f64'` and `'bool'` are excluded on purpose — a `Switch` scrutinee must lower
 *  to a WGSL `switch`, which only accepts integer cases, and an array index or bit-op operand
 *  is never boolean.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 */
export type ScalarKey = 'f32' | 'i32' | 'u32'

/** The runtime twin of {@link KeyOf} — turns any `ShaderType` VALUE (not just a literal `tsc`
 *  can narrow) into its canonical string key (`'vec3<f32>'`, `'mat4x4<f32>'`,
 *  `'texture_2d_array<f32>'`, …), used both for error messages (`SD0002`/`SD0004`: "expected
 *  vec3<f32>, got vec4<f32>") and by {@link typeEq} to compare two types structurally. Every
 *  `case` here must stay byte-identical to `KeyOf`'s matching conditional arm — a mismatch
 *  means a value type-checks at author time but throws a spurious mismatch at author-run time,
 *  or vice versa.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 *
 *  @example
 *  ```ts
 *  import { typeKey, vec3fT, texture2dArrayfT } from '@xgis/shader-dsl'
 *
 *  typeKey(vec3fT) // 'vec3<f32>'
 *  typeKey(texture2dArrayfT) // 'texture_2d_array<f32>'
 *  ```
 */
export function typeKey(t: ShaderType): string {
  switch (t.kind) {
    case 'scalar':
      return t.scalar
    case 'f64':
      return 'f64'
    case 'vec64':
      return `vec${t.n}<f64>`
    case 'vec':
      return `vec${t.n}<${t.elem}>`
    case 'mat':
      return `mat${t.n}x${t.n}<${t.elem}>`
    case 'struct':
      return `struct:${t.name}`
    case 'array':
      return t.size !== undefined
        ? `array<${typeKey(t.elem)},${t.size}>`
        : `array<${typeKey(t.elem)}>`
    case 'texture':
      // Every dim is spelled EXPLICITLY — a `texture_${t.dim}<…>` template would emit
      // the invalid `texture_2d-array<f32>` for the array arm (and '2d-ms' already
      // needed its own spelling). Must stay byte-identical to KeyOf's arms above.
      // Exhaustive switch: a NEW dim fails compilation here instead of silently
      // falling open to the 2d spelling.
      switch (t.dim) {
        case '2d-ms':
          return `texture_multisampled_2d<${t.elem}>`
        case '2d-array':
          return `texture_2d_array<${t.elem}>`
        case '2d':
          return `texture_2d<${t.elem}>`
        default:
          // Exhaustiveness on the whole ARM, not on `t.dim` (#1703): the texture type
          // is now a two-arm union, so once every dim is handled `t` itself is `never`
          // and `t.dim` no longer exists to check. A new dim (or a new arm) still
          // fails compilation right here.
          return t satisfies never
      }
    case 'sampler':
      return 'sampler'
    case 'void':
      return 'void'
  }
}

/** Structural equality for `ShaderType` — two types are equal iff their {@link typeKey}
 *  strings match, so `boolT`-style constants compare equal to a freshly-built `{ kind:
 *  'scalar', scalar: 'bool' }` object even though they aren't the same reference. This is the
 *  check every binary-op / assignment / `fn`-argument type gate in `node.ts` runs before
 *  raising `SD0002` ("type mismatch") — never compare two `ShaderType`s with `===` or a deep
 *  equal, use this.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 *
 *  @example
 *  ```ts
 *  import { typeEq, boolT } from '@xgis/shader-dsl'
 *
 *  typeEq(boolT, { kind: 'scalar', scalar: 'bool' }) // true — same key, different object
 *  ```
 */
export function typeEq(a: ShaderType, b: ShaderType): boolean {
  return typeKey(a) === typeKey(b)
}

/** Narrows a `ShaderType` to the native `{ kind: 'vec' }` arm — `elem` is `'f32' | 'i32' |
 *  'u32'` (no `'bool'`, no `'f64'`; the emulated-double vector is the SEPARATE `'vec64'` kind,
 *  see {@link isVec64}). Used throughout `node.ts`'s binary-op type resolution (`isMat(a) &&
 *  isVec(b)`, `isVec(a) && isScalar(b)`) to decide vec∘scalar broadcast vs mat·vec vs a
 *  same-kind op, and by `.x`/`.y`/`.r`/`.g` swizzle guards to reject a non-vector receiver.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 *
 *  @example
 *  ```ts
 *  import { isVec, vec3fT, f32T } from '@xgis/shader-dsl'
 *
 *  isVec(vec3fT) // true
 *  isVec(f32T) // false
 *  ```
 */
export const isVec = (t: ShaderType): t is Extract<ShaderType, { kind: 'vec' }> => t.kind === 'vec'
/** Narrows a `ShaderType` to the native `{ kind: 'scalar' }` arm (`f32`/`i32`/`u32`/`bool`) —
 *  `false` for {@link f64T}, which is its own kind precisely so this predicate does NOT treat
 *  it as a scalar. Used in `node.ts`'s arithmetic type resolution to detect the vec∘scalar
 *  broadcast case (`isVec(a) && isScalar(b)` — and its mirror `isScalar(a) && isVec(b)` — each
 *  returning the vector operand's type as the result).
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 *
 *  @example
 *  ```ts
 *  import { isScalar, f32T, f64T } from '@xgis/shader-dsl'
 *
 *  isScalar(f32T) // true
 *  isScalar(f64T) // false — f64 is its own ShaderType.kind, not a native scalar
 *  ```
 */
export const isScalar = (t: ShaderType): t is Extract<ShaderType, { kind: 'scalar' }> =>
  t.kind === 'scalar'
/** Narrows a `ShaderType` to the native `{ kind: 'mat' }` arm — matches BOTH `elem: 'f32'`
 *  (native `matNxN<f32>`) and `elem: 'f64'` (emulated, lowered to a `DF64MatN` struct); use
 *  {@link isMat64} when the f32/f64 distinction itself matters. `node.ts` checks this before a
 *  `mat·vec` or `mat·mat` op (`isMat(a) && isVec(b)`, `isMat(a) && isMat(b)`).
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 *
 *  @example
 *  ```ts
 *  import { isMat, mat4x4fT, mat2f64T } from '@xgis/shader-dsl'
 *
 *  isMat(mat4x4fT) // true
 *  isMat(mat2f64T) // also true — use isMat64 to tell them apart
 *  ```
 */
export const isMat = (t: ShaderType): t is Extract<ShaderType, { kind: 'mat' }> => t.kind === 'mat'
/** An emulated-double matrix (`matNxN<f64>`), lowered to a DF64MatN column struct. */
export const isMat64 = (
  t: ShaderType,
): t is Extract<ShaderType, { kind: 'mat' }> & { elem: 'f64' } =>
  t.kind === 'mat' && t.elem === 'f64'
/** Narrows a `ShaderType` to the emulated-double scalar arm ({@link f64T}). `node.ts`'s
 *  arithmetic resolution checks this FIRST, before native scalar promotion, so an `f64`
 *  operand always wins the result type over a plain `f32`/number — mixing `f64` with an
 *  `i32`/`u32`/`bool` operand instead falls through to an `SD0004` throw, since df64 only
 *  widens from f32/number, never from another native integer kind.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 *
 *  @example
 *  ```ts
 *  import { isF64, f64T, f32T } from '@xgis/shader-dsl'
 *
 *  isF64(f64T) // true
 *  isF64(f32T) // false
 *  ```
 */
export const isF64 = (t: ShaderType): t is Extract<ShaderType, { kind: 'f64' }> => t.kind === 'f64'
/** Narrows a `ShaderType` to the emulated-double VECTOR arm ({@link vec2f64T} and its 3/4-wide
 *  siblings) — distinct from {@link isVec}, which only matches the native `vec` kind and is
 *  `false` for a df64 vector. `.comp()`/swizzle guards in `node.ts` accept EITHER `isVec(t) ||
 *  isVec64(t)` since both kinds support component access, just through a different lowering.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/core/ir`.
 *
 *  @example
 *  ```ts
 *  import { isVec64, vec2f64T, vec2fT } from '@xgis/shader-dsl'
 *
 *  isVec64(vec2f64T) // true
 *  isVec64(vec2fT) // false — native vec, use isVec for that
 *  ```
 */
export const isVec64 = (t: ShaderType): t is Extract<ShaderType, { kind: 'vec64' }> =>
  t.kind === 'vec64'
