// ═══ Shader DSL — IR types ═══
//
// ShaderType (the runtime type descriptor), the branded type constants, the
// type-level key machinery (KeyOf/ElemKey/ScalarKey) that powers the
// compile-time type-safety gate, and the type predicates/helpers. No Node
// dependency — this is the leaf of the core/ir import DAG
// (types ← nodes ← node ← builder).

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
export const f32T = { kind: 'scalar', scalar: 'f32' } as const satisfies ShaderType
export const f64T = { kind: 'f64' } as const satisfies ShaderType
export const vec2f64T = { kind: 'vec64', n: 2 } as const satisfies ShaderType
export const vec3f64T = { kind: 'vec64', n: 3 } as const satisfies ShaderType
export const vec4f64T = { kind: 'vec64', n: 4 } as const satisfies ShaderType
export const i32T = { kind: 'scalar', scalar: 'i32' } as const satisfies ShaderType
export const u32T = { kind: 'scalar', scalar: 'u32' } as const satisfies ShaderType
export const boolT = { kind: 'scalar', scalar: 'bool' } as const satisfies ShaderType
export const vec2fT = { kind: 'vec', n: 2, elem: 'f32' } as const satisfies ShaderType
export const vec3fT = { kind: 'vec', n: 3, elem: 'f32' } as const satisfies ShaderType
export const vec4fT = { kind: 'vec', n: 4, elem: 'f32' } as const satisfies ShaderType
export const vec2uT = { kind: 'vec', n: 2, elem: 'u32' } as const satisfies ShaderType
export const vec3uT = { kind: 'vec', n: 3, elem: 'u32' } as const satisfies ShaderType
export const vec4uT = { kind: 'vec', n: 4, elem: 'u32' } as const satisfies ShaderType
export const vec2iT = { kind: 'vec', n: 2, elem: 'i32' } as const satisfies ShaderType
export const vec4iT = { kind: 'vec', n: 4, elem: 'i32' } as const satisfies ShaderType
export const mat4x4fT = { kind: 'mat', n: 4, elem: 'f32' } as const satisfies ShaderType
export const mat2f64T = { kind: 'mat', n: 2, elem: 'f64' } as const satisfies ShaderType
export const mat3f64T = { kind: 'mat', n: 3, elem: 'f64' } as const satisfies ShaderType
export const mat4f64T = { kind: 'mat', n: 4, elem: 'f64' } as const satisfies ShaderType
export const texture2dfT = { kind: 'texture', dim: '2d', elem: 'f32' } as const satisfies ShaderType
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
export const samplerT = { kind: 'sampler' } as const satisfies ShaderType
export const voidT = { kind: 'void' } as const satisfies ShaderType
export const structT = (name: string): ShaderType => ({ kind: 'struct', name })
/** Array type; pass `size` for a fixed-length WGSL array (`array<T, N>`). */
export const arrayT = (elem: ShaderType, size?: number): ShaderType => ({
  kind: 'array',
  elem,
  size,
})

// Type-level key of a ShaderType literal — the phantom carried by Node<K>.
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
export type ScalarKey = 'f32' | 'i32' | 'u32'

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

export function typeEq(a: ShaderType, b: ShaderType): boolean {
  return typeKey(a) === typeKey(b)
}

export const isVec = (t: ShaderType): t is Extract<ShaderType, { kind: 'vec' }> => t.kind === 'vec'
export const isScalar = (t: ShaderType): t is Extract<ShaderType, { kind: 'scalar' }> =>
  t.kind === 'scalar'
export const isMat = (t: ShaderType): t is Extract<ShaderType, { kind: 'mat' }> => t.kind === 'mat'
/** An emulated-double matrix (`matNxN<f64>`), lowered to a DF64MatN column struct. */
export const isMat64 = (
  t: ShaderType,
): t is Extract<ShaderType, { kind: 'mat' }> & { elem: 'f64' } =>
  t.kind === 'mat' && t.elem === 'f64'
export const isF64 = (t: ShaderType): t is Extract<ShaderType, { kind: 'f64' }> => t.kind === 'f64'
export const isVec64 = (t: ShaderType): t is Extract<ShaderType, { kind: 'vec64' }> =>
  t.kind === 'vec64'
