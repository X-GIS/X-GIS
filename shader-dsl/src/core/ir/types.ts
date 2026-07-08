// ═══ Shader DSL — IR types ═══
//
// ShaderType (the runtime type descriptor), the branded type constants, the
// type-level key machinery (KeyOf/ElemKey/ScalarKey) that powers the
// compile-time type-safety gate, and the type predicates/helpers. No Node
// dependency — this is the leaf of the core/ir import DAG
// (types ← nodes ← node ← builder).

export type Scalar = 'f32' | 'i32' | 'u32' | 'bool'

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
  | { readonly kind: 'texture'; readonly dim: '2d' | '2d-ms'; readonly elem: 'f32' }
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
            : T extends { kind: 'texture'; dim: '2d' }
              ? 'texture_2d<f32>'
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
      return t.dim === '2d-ms'
        ? `texture_multisampled_2d<${t.elem}>`
        : `texture_${t.dim}<${t.elem}>`
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
