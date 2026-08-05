// ═══ Live values for declared `input`s (#1539) ═══
//
// The host-contract half of the `input` feature: the compiler resolves
// `input threshold: f32 = 0.5` into a `ResolvedInputInfo` table carried on
// `SceneCommands.inputs`; this store holds the LIVE value for each declared
// name and hands it to the two consumers that need it:
//
//   • the CPU evaluator, via `toEvalInputs()` → `makeEvalProps({ inputs })`,
//     which prefixes each name with `INPUT_KEY_PREFIX`. This covers the eval
//     sites that run per feature at build time — filters, labels/text, point
//     sizes — where an `InputRef` is resolved by `evaluate()` directly.
//   • the GPU reserved uniform pool (`u.input_f32_N` / `u.input_color_N` in
//     the polygon Uniforms struct), via `f32Slots` / `colorSlots`.
//
// The GPU pool is the path every PAINT expression takes: optimize.ts folds a
// `data-driven` paint value only when `classifyExpr` says `'constant'`, so an
// `input-dependent` opacity/colour stays data-driven and reaches shader
// codegen — there is no per-frame CPU re-evaluation of paint values to route
// it through instead. The pool's struct fields are NOT wired yet (polygon.ts
// is at its LOC ceiling and UniformBlock rejects array fields, so the 12
// scalar lanes need their own change); `f32Slots`/`colorSlots` are the
// already-correct CPU side of that write, kept here so the slot mapping has
// one home.
//
// Slot indices are assigned by the COMPILER (declaration order, independently
// per type) and arrive on each `ResolvedInputInfo` — this store never invents
// one, so the CPU write and the shader's read agree by construction.
//
// `set()` THROWS on an unknown name or a type mismatch rather than silently
// no-op'ing: a typo'd `map.setInput('treshold', …)` that quietly did nothing
// is exactly the class of failure `input` exists to remove.

import { INPUT_F32_POOL_SIZE, INPUT_COLOR_POOL_SIZE, type ResolvedInputInfo } from '@xgis/compiler'
import { hexToRgba } from '../feature-helpers'

/** A live input value, in the shape `evaluate()` yields for the matching
 *  literal: `f32` → number, `color` → hex STRING (never an RGBA tuple, so a
 *  live value and a carried compile-time default stay interchangeable). */
export type InputValue = number | string

export class InputStore {
  private decls = new Map<string, ResolvedInputInfo>()
  private values = new Map<string, InputValue>()
  /** GPU pool mirrors — index N is `u.input_f32_N` / `u.input_color_N`
   *  (colour as RGBA 0..1, matching `u.fill_color`'s convention). */
  readonly f32Slots = new Float32Array(INPUT_F32_POOL_SIZE)
  readonly colorSlots = new Float32Array(INPUT_COLOR_POOL_SIZE * 4)
  /** Memoised `toEvalInputs()` result — rebuilt only when a value changes.
   *  The eval path calls this per feature per frame; a fresh object each
   *  time would allocate in the paint hot loop. */
  private evalCache: Record<string, InputValue> | null = null

  /** Adopt a newly compiled scene's declarations, seeding every input with its
   *  compile-time default and DROPPING any name the new scene doesn't declare.
   *  A value previously set for a name the new scene still declares is kept —
   *  a restyle shouldn't silently snap a host-driven input back to its default. */
  reset(decls: readonly ResolvedInputInfo[] | undefined): void {
    this.decls = new Map((decls ?? []).map((d) => [d.name, d]))
    const kept = new Map<string, InputValue>()
    for (const d of this.decls.values()) {
      const prev = this.values.get(d.name)
      // Keep the live value only if the declaration's TYPE still matches;
      // `input x: f32` restyled to `input x: color` must re-seed, not carry
      // a number into a colour slot.
      kept.set(d.name, prev !== undefined && typeMatches(d, prev) ? prev : d.default.value)
    }
    this.values = kept
    this.evalCache = null
    this.f32Slots.fill(0)
    this.colorSlots.fill(0)
    for (const d of this.decls.values()) this.writeSlot(d, this.values.get(d.name)!)
  }

  /** Set a declared input's live value. Returns true when the value actually
   *  changed (the caller redraws only then). Throws on an unknown name or a
   *  value whose type doesn't match the declaration. */
  set(name: string, value: InputValue): boolean {
    const decl = this.decls.get(name)
    if (!decl) {
      throw new Error(
        `setInput: no \`input ${name}\` is declared by the current style` +
          (this.decls.size ? ` (declared: ${[...this.decls.keys()].join(', ')})` : ''),
      )
    }
    if (!typeMatches(decl, value)) {
      throw new Error(
        `setInput('${name}', …): \`input ${name}\` is declared \`: ${decl.type}\`, ` +
          `so its value must be ${decl.type === 'f32' ? 'a finite number' : 'a hex colour string'}` +
          ` — got ${JSON.stringify(value)}`,
      )
    }
    if (this.values.get(name) === value) return false
    this.values.set(name, value)
    this.evalCache = null
    this.writeSlot(decl, value)
    return true
  }

  /** The live value, or undefined when no such input is declared. */
  get(name: string): InputValue | undefined {
    return this.values.get(name)
  }

  /** Every declared input name, in declaration order. */
  names(): string[] {
    return [...this.decls.keys()]
  }

  /** The `{ name: value }` map `makeEvalProps({ inputs })` prefixes. Returns a
   *  STABLE object between mutations — do not mutate the result. */
  toEvalInputs(): Record<string, InputValue> {
    if (this.evalCache) return this.evalCache
    const out: Record<string, InputValue> = {}
    for (const [name, v] of this.values) out[name] = v
    return (this.evalCache = out)
  }

  private writeSlot(decl: ResolvedInputInfo, value: InputValue): void {
    if (decl.type === 'f32') {
      this.f32Slots[decl.slot] = value as number
      return
    }
    // typeMatches already rejected an unparseable hex, so the null arm here is
    // unreachable for a stored value; `?? [0,0,0,1]` keeps the write total
    // rather than adding a throw on a branch no caller can take.
    const rgba = hexToRgba(value as string) ?? [0, 0, 0, 1]
    this.colorSlots.set(rgba, decl.slot * 4)
  }
}

function typeMatches(decl: ResolvedInputInfo, value: InputValue): boolean {
  return decl.type === 'f32'
    ? typeof value === 'number' && Number.isFinite(value)
    : typeof value === 'string' && hexToRgba(value) !== null
}
