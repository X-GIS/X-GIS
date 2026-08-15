// ═══ Shader DSL — diagnostic code catalogue ═══
//
// A STABLE, frozen registry of every coded diagnostic the DSL can emit. Each code
// is an `SD####` string with a fixed `summary` (the invariant part of the message)
// and an optional `hint` (a one-line "how to fix it"). The dynamic part of a message
// (the offending types, the field name, …) is passed at the throw site as `detail`
// (see `dslError` in ./error). Keeping the catalogue here — not inline at each throw —
// gives the codes a single source of truth, lets a test snapshot it (so adding /
// removing a code is a deliberate diff), and lets tooling map a code → its docs.
//
// Codes are append-only and never renumbered: a consumer may match on `err.code`.

/** One entry of the diagnostic catalogue: the `SD####` code, the INVARIANT half of its message,
 *  and an optional one-line remedy. The dynamic half of a real error (the offending types, the
 *  field name) is not here — it is supplied at the throw site and composed into
 *  {@link ShaderDslError}'s `.message`, which is why the summary can be relied on as a category
 *  while the message cannot.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/dev`.
 */
export interface ErrorCodeDef {
  readonly code: string
  readonly summary: string
  readonly hint?: string
}

/** The whole diagnostic catalogue, keyed by code — the single source of truth for what every
 *  `SD####` means. Read it to build your own error UI (a code → docs link, a severity map, a
 *  localised message table) rather than parsing `.message`, which composes the summary below
 *  with per-throw detail and is not a stable format.
 *
 *  APPEND-ONLY, and never renumbered: a code that ships keeps its number forever, precisely so
 *  a consumer may `switch` on `err.code` across versions. A test snapshots this object, so
 *  adding or removing an entry is a deliberate diff rather than a silent one.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/dev`.
 *
 *  @example
 *  ```ts
 *  import { CODES, type ErrorCode } from '@xgis/shader-dsl'
 *
 *  const docsUrl = (code: ErrorCode) => `https://x-gis.dev/errors/${code}`
 *  console.log(CODES.SD0002.summary) // 'binary op on mismatched vectors'
 *  ```
 */
export const CODES = {
  // ── Authoring-time type errors (thrown from core/ir/node.ts) ──
  SD0001: {
    code: 'SD0001',
    summary: 'matrix × vector size mismatch',
    hint: 'a matN can only multiply a vecN of the same N',
  },
  SD0002: {
    code: 'SD0002',
    summary: 'binary op on mismatched vectors',
    hint: 'both operands must be the same vector type, or one must be a scalar',
  },
  SD0003: {
    code: 'SD0003',
    summary: 'arithmetic op on a bool operand',
    hint: 'bool is not a numeric type — use a comparison/logical op, or cast first',
  },
  SD0004: { code: 'SD0004', summary: 'binary op on incompatible types' },
  SD0005: {
    code: 'SD0005',
    summary: 'bitwise op requires a u32/i32 left operand',
    hint: 'cast the operand with toU32()/toI32() before a bitwise op',
  },
  SD0006: { code: 'SD0006', summary: 'component access on a non-vector' },
  SD0007: {
    code: 'SD0007',
    summary: 'vector component out of range',
    hint: '.z/.w need a vec3/vec4 respectively',
  },
  SD0008: { code: 'SD0008', summary: 'swizzle on a non-vector' },
  SD0009: {
    code: 'SD0009',
    summary: '.select() on a non-bool condition',
    hint: 'the receiver of .select(a, b) must be a Node<bool>',
  },
  SD0010: {
    code: 'SD0010',
    summary: 'select branches have differing types',
    hint: 'both branches of a select/ifExpr must share a type',
  },
  SD0011: {
    code: 'SD0011',
    summary: 'matchExpr case type does not match the default',
    hint: 'every case value and the default must share one type',
  },
  SD0012: {
    code: 'SD0012',
    summary: 'statement sink not installed',
    hint: 'import @xgis/shader-dsl from its entry, not a deep path',
  },
  SD0013: {
    code: 'SD0013',
    summary: 'no active builder',
    hint: 'call Let/Var/If/Loop/… inside an fn / If / Loop body',
  },
  SD0014: {
    code: 'SD0014',
    summary: 'override (specialization constant) must be a WGSL scalar type',
    hint: 'overrideConst supports bool/i32/u32/f32 only — WGSL forbids vec/matrix/array/struct overrides; decompose into per-component scalar overrides',
  },
  SD0015: {
    code: 'SD0015',
    summary: 'array-texture layer must be an integer',
    hint: 'a fractional layer literal is a naga compile error in WGSL but silently rounds in GLSL (layer = floor(z + 0.5), so 1.5 reads layer 2) — the backends would diverge; pass an integer, or an i32/u32 node',
  },

  // ── Module-level gates ──
  SD0020: { code: 'SD0020', summary: 'module validation failed' },
  SD0030: {
    code: 'SD0030',
    summary: 'unsupported feature for this backend',
    // #1717 Ask 3 — close the discovery loop. The error already names the capability; what
    // a reader needs next is where the per-backend support table lives, and that a
    // capability with no row is a HARD stop rather than something to work around.
    hint: 'see AUTHORING.md §10 (Capabilities & extensions) for the per-backend support table; a capability the target has no capProfile row for fails closed by design',
  },

  // ── fp64 (emulated double precision) — passes/fp64-lower.ts ──
  SD0040: {
    code: 'SD0040',
    summary: 'f64 type leaked past fp64Lower into a backend emitter',
    hint: 'internal invariant — the fp64 lowering pass must rewrite every f64 before emit; report a shader-dsl bug',
  },
  SD0041: {
    code: 'SD0041',
    summary: 'unsupported operation on f64 operands',
    hint: 'only + - * / compare, abs, min, max, sqrt, mix, floor, fract (and on vectors dot, length, distance, normalize) are emulated — narrow explicitly with toF32(x) first',
  },
  SD0042: {
    code: 'SD0042',
    summary: 'conflicting fp64 guard declaration',
    hint: "the '_fp64' binding is reserved for the auto-injected guard texture (texture_2d<f32>) — remove the conflicting declaration, or pin the slot with fp64Guard({ group, binding })",
  },
  SD0043: {
    code: 'SD0043',
    summary: 'reserved fp64 name',
    hint: 'fp64Lower injects df64_* emulation fns and DF64VecN structs under those names — rename the colliding declaration',
  },
  SD0044: {
    code: 'SD0044',
    summary: 'f64 in an interpolated @location IO field',
    hint: 'interpolating hi/lo pairs is numerically wrong — narrow with toF32, or carry two f32 varyings explicitly',
  },

  // ── Lint-rule diagnostics surfaced through diagnose() ──
  SD0107: {
    code: 'SD0107',
    summary: "assignment to an immutable 'let' binding",
    hint: 'declare the binding with Var() instead of Let() to mutate it',
  },
  SD0108: {
    code: 'SD0108',
    summary: 'smoothstep with constant edge0 >= edge1 (undefined in GLSL ES)',
    hint: 'write 1 − smoothstep(lo, hi, x) instead of reversing the edges',
  },
  // The hint is deliberately GENERIC and enumerates NO fix family (#1654): the
  // per-builtin fix lives in the rule's FRAGMENT_ONLY_IDS table (the single
  // fix-authority) and reaches the reader through the diagnostic's own message.
  // Enumerating families here would re-create the untested sync contract that
  // table replaced — one new family and the catalogue would lie again.
  SD0109: {
    code: 'SD0109',
    summary: 'a fragment-only builtin is reachable from a vertex or compute entry',
    hint: 'the fix is per-builtin and named in the diagnostic message itself — the fragment-only-builtin rule table (FRAGMENT_ONLY_IDS) is the single fix-authority',
  },
} as const satisfies Record<string, ErrorCodeDef>

/** The union of every diagnostic code the DSL can emit — `'SD0001' | 'SD0002' | …`, derived
 *  from {@link CODES} rather than restated, so the two can never disagree. Annotate a handler
 *  parameter with it and `tsc` will reject a typo'd or retired code, and an exhaustive `switch`
 *  over it will fail to compile when a new code is added.
 *
 *  Note this is the type of a code the package CAN throw, not a promise about
 *  {@link ShaderDslError}'s `.code` field, which is a plain `string` — a subclass or a future
 *  version may carry a code this union does not have, so narrow rather than assume.
 *
 *  Exported from `@xgis/shader-dsl`, `@xgis/shader-dsl/dev`.
 */
export type ErrorCode = keyof typeof CODES
