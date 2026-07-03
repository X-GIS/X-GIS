// ═══ UniformBlock — reflect-derived, typed std140 uniform pack target (#733) ═══
//
// The per-frame uniform WRITE used to be raw lane arithmetic into a bare
// Float32Array (`uf[U_VIEWPORT + 2] = mpp`): untyped, hand-padded, and with no
// completeness check — skip one field (the #600 globe_eye class) and the shader
// reads silent zeros. reflect()/wgslLayout() already removed the OFFSET drift;
// this class removes the WRITE drift by deriving the pack surface from the same
// reflected layout the WGSL struct is emitted from.
//
// Two write surfaces, one byte store:
//   • `block.write({ mvp, viewport, … })` — full-struct pack. The value object's
//     type is mapped from the uniformStruct's field record, so COMPLETENESS IS
//     COMPILE-TIME: omitting a field, misspelling one, or passing the wrong
//     arity/shape is a tsc error, not a NaN at runtime. Allocates small tuples —
//     intended for once-per-frame packers, not inner loops.
//   • `block.set.field(x, y, z, w)` — per-field monomorphic setters, codegen'd
//     ONCE at construction with the exact arity of the reflected type. Zero
//     per-call allocation — intended for hot loops (per-tile patches) AFTER a
//     frame-level `write()` established a complete buffer.
//
// Layout source — the uniformStruct HANDLE alone, via wgslLayout(U.struct,
// 'std140'). This lays out the struct WITHOUT assembling a module: never walks
// funcs, never triggers the projection emit — #612-free by construction (safe
// even at module scope, though consumers should still construct lazily per
// no-eager-uniform-reflect). There is deliberately NO reflect(module) entry:
// a struct that needs the module's structs map to lay out (nested/array fields,
// e.g. the line LineLayer with its PatternSlot array) also has fields this
// class cannot pack — those keep their bespoke packers (the LineLayer
// carve-out in #733), so a module-sourced constructor would have no consumer.
//
// NOT expressible here (fail loud at construction, keep the bespoke packer):
// mat3 (per-column std140 padding), array fields, nested struct fields.
//
// Content-blind (Gate-6): knows bytes and reflected layouts, zero geo/map.
// Backend-neutral: pure std140 CPU bytes — the same ArrayBuffer feeds the
// WebGPU uniform path and the WebGL2 UBO path verbatim.

import { wgslLayout } from '@xgis/shader-dsl'
import type { KeyOf, ShaderType, StructLayout, UniformStruct } from '@xgis/shader-dsl'
import { devAssert } from '@xgis/shared'

type Kind = 'f32' | 'u32' | 'i32'

/** JS value shape for a reflected field, keyed by the DSL's type key. Vectors are
 *  exact-arity tuples (contextual typing checks the literal's length); matrices
 *  take any ArrayLike (16 lanes as a tuple would be noise, dev-asserted instead). */
export type UniformValueFor<K extends string> = K extends `mat${number}x${number}<${string}>`
  ? ArrayLike<number>
  : K extends `vec4<${string}>`
    ? readonly [number, number, number, number]
    : K extends `vec3<${string}>`
      ? readonly [number, number, number]
      : K extends `vec2<${string}>`
        ? readonly [number, number]
        : K extends 'f32' | 'u32' | 'i32'
          ? number
          : number | ArrayLike<number> // KeyOf widened to string (untyped Record<string, ShaderType> blocks)

/** Fixed-arity setter for a reflected field (the zero-alloc hot-loop surface). */
export type UniformSetterFor<K extends string> = K extends `mat${number}x${number}<${string}>`
  ? (m: ArrayLike<number>) => void
  : K extends `vec4<${string}>`
    ? (x: number, y: number, z: number, w: number) => void
    : K extends `vec3<${string}>`
      ? (x: number, y: number, z: number) => void
      : K extends `vec2<${string}>`
        ? (x: number, y: number) => void
        : K extends 'f32' | 'u32' | 'i32'
          ? (x: number) => void
          : (...lanes: number[]) => void // KeyOf widened to string (untyped Record<string, ShaderType> blocks)

/** The full-struct value object for `write()` — one entry per reflected field. */
export type UniformValues<F extends Record<string, ShaderType>> = {
  readonly [K in keyof F & string]: UniformValueFor<KeyOf<F[K]>>
}

interface FieldWriter {
  readonly name: string
  readonly write: (v: number | ArrayLike<number>) => void
}

// 'u32'/'vec4<u32>' → u32 view; 'i32'/'vec4<i32>' → i32; everything else (f32
// scalars/vecs, matNxN<f32>) → f32. Guarded fields (struct/array) never reach here.
const kindOf = (typeKey: string): Kind =>
  typeKey.includes('u32') ? 'u32' : typeKey.includes('i32') ? 'i32' : 'f32'

export class UniformBlock<F extends Record<string, ShaderType> = Record<string, ShaderType>> {
  /** The packed std140 bytes — hand to UniformRing.stageSlot / rhi.writeBuffer verbatim. */
  readonly buffer: ArrayBuffer
  readonly byteLength: number
  /** Per-field fixed-arity setters (zero-alloc hot-loop surface). `set.viewprot`
   *  is a tsc error; so is calling a vec4 setter with 3 lanes or a mat4 with lanes. */
  readonly set: { readonly [K in keyof F & string]: UniformSetterFor<KeyOf<F[K]>> }

  private readonly f32: Float32Array
  private readonly writers: readonly FieldWriter[]
  private readonly byteOffsets: ReadonlyMap<string, number>

  private constructor(layout: StructLayout) {
    this.buffer = new ArrayBuffer(layout.size)
    this.byteLength = layout.size
    this.f32 = new Float32Array(this.buffer)
    const u32 = new Uint32Array(this.buffer)
    const i32 = new Int32Array(this.buffer)

    const setters: Record<string, (...lanes: never[]) => void> = {}
    const writers: FieldWriter[] = []
    const byteOffsets = new Map<string, number>()

    for (const fl of layout.fields) {
      // Fields the flat fast path cannot pack correctly — per-column mat3 padding,
      // array strides, nested structs — fail LOUD at construction (prod included):
      // a silent mis-pack here is exactly the corruption class this type retires.
      if (
        fl.type.startsWith('struct:') ||
        fl.type.startsWith('array') ||
        fl.type.startsWith('mat3')
      ) {
        throw new Error(
          `UniformBlock: field '${fl.name}' (${fl.type}) needs column/stride-aware packing — ` +
            `keep its bespoke packer (see the LineLayer carve-out in #733)`,
        )
      }
      if (fl.offset % 4 !== 0) {
        throw new Error(
          `UniformBlock: field '${fl.name}' offset ${fl.offset} is not 4-byte aligned`,
        )
      }
      const off = fl.offset / 4
      const lanes = fl.size / 4
      const view = kindOf(fl.type) === 'u32' ? u32 : kindOf(fl.type) === 'i32' ? i32 : this.f32
      byteOffsets.set(fl.name, fl.offset)

      // Matrices (mat2/mat4 — column-contiguous under std140) + all vectors write
      // through TypedArray.set; scalars store one lane. The vec3 std140 pad lane
      // (+3) is zeroed by ArrayBuffer init and never written — deterministic bytes.
      if (lanes === 1) {
        const s = (x: number): void => {
          view[off] = x
        }
        setters[fl.name] = s
        writers.push({
          name: fl.name,
          write: (v) => {
            view[off] = v as number
          },
        })
      } else {
        const arr = (v: number | ArrayLike<number>): void => {
          const a = v as ArrayLike<number>
          devAssert(
            a.length === lanes,
            () => `UniformBlock '${fl.name}': expected ${lanes} lanes, got ${a.length}`,
          )
          view.set(a, off)
        }
        writers.push({ name: fl.name, write: arr })
        setters[fl.name] = fl.type.startsWith('mat')
          ? (m: ArrayLike<number>) => arr(m)
          : lanes === 2
            ? (x: number, y: number) => {
                view[off] = x
                view[off + 1] = y
              }
            : lanes === 3
              ? (x: number, y: number, z: number) => {
                  view[off] = x
                  view[off + 1] = y
                  view[off + 2] = z
                }
              : (x: number, y: number, z: number, w: number) => {
                  view[off] = x
                  view[off + 1] = y
                  view[off + 2] = z
                  view[off + 3] = w
                }
      }
    }

    this.set = Object.freeze(setters) as this['set']
    this.writers = writers
    this.byteOffsets = byteOffsets
  }

  /** Layout from the uniformStruct HANDLE alone via wgslLayout(U.struct, 'std140')
   *  — module-free, #612-free by construction. Throws (from wgslLayout's
   *  structByName) if the struct nests other structs — those keep bespoke packers. */
  static of<F extends Record<string, ShaderType>>(u: UniformStruct<F>): UniformBlock<F> {
    return new UniformBlock<F>(wgslLayout(u.struct, 'std140'))
  }

  /** Full-struct pack — one entry per reflected field, completeness enforced by
   *  tsc (the mapped type has no optional members). Tuple/object allocation is
   *  fine at once-per-frame call rates; hot loops patch via `set.*` instead. */
  write(values: UniformValues<F>): this {
    const list = this.writers
    const v = values as Record<string, number | ArrayLike<number> | undefined>
    for (let i = 0; i < list.length; i++) {
      const w = list[i]!
      const x = v[w.name]
      devAssert(
        x !== undefined,
        () => `UniformBlock.write: field '${w.name}' missing (untyped caller?)`,
      )
      w.write(x as number | ArrayLike<number>)
    }
    return this
  }

  /** Reflected byte offset of a field — for parity tests / debug, not for writes. */
  fieldOffset(name: keyof F & string): number {
    const off = this.byteOffsets.get(name)
    if (off === undefined) throw new Error(`UniformBlock.fieldOffset: no field '${name}'`)
    return off
  }

  /** Ring-slot stride: byteLength rounded up to `align` (WebGPU minUniformBufferOffsetAlignment). */
  std140Stride(align = 256): number {
    return Math.ceil(this.byteLength / align) * align
  }
}

/** Factory sugar for the common flat-struct path: `uniformBlock(U)`. */
export function uniformBlock<F extends Record<string, ShaderType>>(
  u: UniformStruct<F>,
): UniformBlock<F> {
  return UniformBlock.of(u)
}

/** Block type for a given uniformStruct handle — lets consumers type a memoised
 *  block field (`_block: UniformBlockOf<typeof U> | null`) without re-stating F.
 *  The `infer F extends` bound filters to flat (scalar/vec/mat) field records —
 *  a struct with `arrayOf(…)` handle-array fields resolves to `never`, matching
 *  the constructor's fail-loud array rejection (those keep bespoke packers). */
export type UniformBlockOf<U> =
  U extends UniformStruct<infer F extends Record<string, ShaderType>> ? UniformBlock<F> : never
