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

export interface ErrorCodeDef {
  readonly code: string
  readonly summary: string
  readonly hint?: string
}

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

  // ── Module-level gates ──
  SD0020: { code: 'SD0020', summary: 'module validation failed' },
  SD0030: { code: 'SD0030', summary: 'unsupported feature for this backend' },

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
} as const satisfies Record<string, ErrorCodeDef>

export type ErrorCode = keyof typeof CODES
